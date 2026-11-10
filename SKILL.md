---
name: maestri-canvas
description: Instruções essenciais para agentes (claude, codex, opencode) operando dentro de um terminal do Maestri Canvas Web. Explica como ver os nós conectados e usar o comando `maestri` para conversar com outros agentes, ler/escrever notas, navegar portais, notificar e (Maestro) recrutar agentes.
---

# Maestri Canvas Skill

Você roda em um terminal de um nó do **Maestri Canvas Web**, ligado por arestas a outros nós: agentes (terminais), notas adesivas e portais (navegadores). O comando `maestri` já está no seu PATH e o ambiente (`MAESTRI_API_URL`, `MAESTRI_PROJECT_ID`, `MAESTRI_NODE_ID`, `MAESTRI_TOKEN_FILE`) já está configurado (o token é só deste terminal e só vale para este projeto).

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
maestri note delete --stack "Fichário"                   # apaga o fichário e as notas dele (destrutivo; recusa se houver nota travada)
maestri note create ["conteúdo"] [--name "Nome"] [--stack ["Fichário"]] [--color C]   # nome = 1ª linha, a menos que --name fixe; imprime o nome exato
maestri note stack "Notas" ["Fichário"]                  # guarda a nota num fichário (cria se preciso)
maestri note unstack "Notas"                             # tira do fichário
maestri arrange ["Nome"] [--name N] [--icon I] [--color C] [--agent|--note|--band|--fichario]   # renomeia/estiliza você, uma nota ou (Maestro) um agente; sem args mostra; --help lista ícones/cores; a flag de tipo só é preciso quando o mesmo nome existe em mais de um tipo
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
maestri portal check "Preview"                           # sem alvo só espia: imprime o caminho de um screenshot
maestri portal drag "Preview" @e3 @e7                    # arrasta de um elemento/ponto até outro (@eN, CSS ou x,y)
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

## Ao terminar uma tarefa delegada
Se alguém (o Maestro ou outro agente) pediu a tarefa, devolva o resultado a quem pediu:
```bash
maestri send "Nome de quem pediu" "Pronto: <resumo curto do que foi feito e onde está o resultado>"
```
- `send` não espera resposta e já envia o Enter sozinho: não precisa de mais nada. Resuma (o texto vai digitado no terminal do outro agente); detalhes longos vão numa nota (`maestri note write`) e você cita o nome dela.
- **Nunca** use `--raw` nem escreva por conta própria no terminal de outro agente para entregar o resultado, e não espere que a pessoa cole nada.
- Use `ask` só quando você precisa da resposta do outro antes de continuar; para avisar que acabou, é `send`.

## Face de chat
Os usuários também conversam com você pela **face de chat** do seu nó: a mensagem chega digitada no seu terminal (menções `@Nota` vêm com a dica de como ler). **Quando receber mensagens pela face de chat (cabeçalho `Below is a message from the user through Maestri Chat` com `thread: <cor>`), responda SOMENTE com `maestri say`** — é o que aparece, renderizado em Markdown, para todos que estão no canvas, na thread (cor) da última mensagem do usuário; a saída crua do terminal vira só um bloco recolhido. `maestri chat reply` continua funcionando como alias.

```bash
maestri say "Pronto! Veja o resumo:\n\n- item 1\n- item 2"   # aceita Markdown; sem argumento lê stdin (heredoc)
maestri say --file resposta.md                                 # texto UTF-8 de um arquivo
maestri say --file grafico.png "legenda"                         # imagem (PNG/JPEG/GIF/WebP) anexada à resposta
maestri say --attach relatorio.pdf --attach dados.zip "pronto"   # arquivos (até 20MB, repetível, só na resposta final)
maestri say "Resultado:\n![gráfico](/caminho/absoluto/img.png)\nfim"  # imagem embutida: linha própria, caminho absoluto
maestri recall attachment <id>                                 # baixa um anexo do chat (o recall mostra os ids) e imprime o caminho
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

## Equipe (só o Maestro)
```
maestri list                                          # você, colegas (com as conexões de cada um aninhadas), bandas, notas, portais
maestri recruit "Hawk" --role "Code Reviewer"          # sem --preset = cópia sua (mesmo comando); nome repetido vira "Hawk (2)"
maestri recruit "Lynx" --preset "Codex" --dir sub/pkg --color rose --icon bot
maestri recruit "Codex" --preset "Codex" --replace "Claude"   # troca o processo NO MESMO nó (cordas, posição e rotinas ficam)
maestri connect "Reviewer" "Tester"                    # agente↔agente; nota/portal só no mesmo andar; portal só com agente
maestri connect "Soundcheck" "Setlist" --note           # nome repetido entre tipos: --agent|--band|--note|--fichario|--portal logo DEPOIS do nome que ela qualifica
maestri preset list | show "X" | create "X" --command "claude --model opus" --maestro on | set "X" --chat on | delete "X"
maestri role list | show "X" | create "X" "prompt" [--scope global] | edit "X" "antigo" "novo" | write "X" "prompt" | assign "Hawk" "X" | delete "X" [--force]
maestri band create "Squad" [--without-me]  |  band add|remove|dissolve "Squad" ["Agente"]
maestri recruit "Hawk" --preset claude --model opus        # --model: claude --model, codex/opencode -m (provider/modelo), agy --model=; muda também pelo chip do nó
maestri partitura list | insert "Time" [--floor F] [--workspace W]   # time salvo: coloca ao lado de você, liga aos Maestros dele (senão a todos), inicia os terminais; a resposta diz quem receber ask
maestri partitura create "Time" ["Agente" ...] [--without-me] [--commands on|off] [--note-text on|off] [--chat-history on|off] [--description D] [--icon I] [--color C] [--scope current|global]
maestri partitura update "Time" ["Agente" ...] [--name N] [...mesmas opções]   |   partitura delete "Time"   # só a pedido do usuário
maestri floor create "Nome" --partitura "Time"            # cria o andar e já coloca o time nele
```
Antes de recrutar rode `maestri list`: se já há alguém com o role certo, delegue com `ask`. Bandas só quando o usuário pedir. Presets novos ficam nas configurações globais; roles `--scope global` ficam no diretório de dados do servidor. `--floor "Andar"` põe o recruta/banda no andar (cwd = checkout do andar); recrutas, bandas e portais nascem no andar de quem os criou.

## Andares e workspaces
Andares são níveis do canvas do projeto ("Ground" = térreo; cada nó tem `data.floor`). Com git, um andar é uma worktree na
própria branch em `<repo>/.worktrees/<slug>` (terminais dele começam nesse checkout).
```
maestri floor list
maestri floor status "Testes verdes" --progress 3/5          # qualquer agente, para o PRÓPRIO andar
maestri floor status "Preciso de decisão" --state blocked    # blocked/review/done também avisam o usuário (toast)
maestri floor create "Nome" [--branch B] [--existing-branch] [--copy] [--no-git] [--copy-ground]   # só Maestro
maestri floor create ["Nome"] --pull-request N|URL [--copy] [--copy-ground]              # só Maestro; usa o gh (autenticado)
maestri floor land "Nome" [--into BRANCH] [--delete-branch] [--keep-floor]                # só Maestro, do térreo; só se o usuário pedir
maestri floor delete "Nome" [--keep-branch] [--force]                                      # só Maestro, do térreo; só se o usuário pedir
maestri floor unload "Nome"                                                                # só Maestro; não o seu andar
maestri workspace list | create "Nome" --dir PATH [--from "Origem"] [--group G] [--folder F] | rename "A" "B" | move "Nome" --group G | --folder F | --root | unload "Nome"   # só Maestro; unload encerra os terminais (não o seu workspace)
```
`floor land` recusa (sem alterar nada) se houver trabalho não commitado no andar ou no térreo, ou conflito de merge; peça ao
agente do andar para commitar antes. Workspaces não têm delete pela CLI.

`--copy` cria um clone completo e isolado em `.worktrees/<slug>` (pode ficar na mesma branch do térreo); `floor land` de um clone
traz o trabalho de volta (fetch + fast-forward/merge na branch do andar ou em `--into`), `floor delete` apaga o clone
(`--keep-branch` guarda os commits numa branch do repositório). `--pull-request` abre um andar na branch do PR aberto (de fork:
branch `pr-N`, commits não chegam ao PR); o seletor de andar mostra o link e o estado do PR.
Desenhos (caneta, formas, setas, texto) são nós `drawing` do canvas, por andar; `floor delete` apaga os do andar.

## Retomada de sessão e contas
Se o terminal de um agente reiniciar (servidor reiniciado, nó reaberto), `claude`/`codex`/`opencode` voltam em modo de retomada (`claude --continue` ou `--resume <id>` da linha que o agente imprimiu ao sair, `codex resume --last`, `opencode --continue`); o programa é detectado pelo executável do comando (com variáveis na frente, caminho completo ou `sh -c`/`fish -c "..."`). `recruit --replace` e `role assign` começam do zero. O toggle fica em Configurações → Retomar sessão (ligado por padrão).
```
maestri account list | create "Work" --cli claude|codex | delete "Work" --cli claude     # só Maestro; delete só a pedido do usuário
maestri recruit "Hawk" --preset "Claude Code" --account "Work"                            # CLAUDE_CONFIG_DIR / CODEX_HOME isolados
maestri recruit --replace "Hawk" --account "Default"                                       # troca só a conta e reinicia
maestri preset create "Claude Work" --command claude --account "Work"                      # preset que já nasce na conta
```
Depois de recrutar numa conta nova, o login é feito rodando o CLI naquele terminal. `maestri preset list` mostra `accounts: "Default", "Work"`; `maestri list` mostra `[conta: Work]`.

## Mensagem "Novo andar" (`<maestri-create-floor skill="maestri-workspace" />`)
Um prompt que começa com `<maestri-create-floor skill="maestri-workspace" />` vem da ação **Novo andar** do chat do agente: a pessoa
quer um andar para a tarefa descrita. Como reagir (você precisa ser o Maestro; senão avise que não pode criar andares):
1. Crie o andar com `maestri floor create "<nome da tarefa em poucas palavras>"` (a branch segue o nome), sem outras flags a menos
   que o prompt peça. Quando a tarefa for **revisar um pull request**, use `maestri floor create --pull-request <número|link>` em vez de um nome.
2. Se o prompt também pedir o trabalho, **recrute alguém no andar** (`maestri recruit "Nome" --floor "<andar>" --role "..."`) em vez de
   fazer você mesmo, e termine o prompt dele com a linha de ask-back.
3. Responda (`maestri say`, se o prompt veio do chat) com o **nome do andar e a branch**.

Andares de PR: o seletor de andar mostra o PR (estado, review, checks), mescla com `gh pr merge` (merge, squash ou rebase; com checks
falhando/pendentes pede confirmação) e passa a seguir sozinho o PR aberto para a branch do andar (detecção pelo `gh pr list --head`).
`maestri workspace create --from` recria os andares git do origem como andares git no destino (a resposta lista o que caiu para sem git).
`maestri arrange` também aceita uma banda (Maestro): nome, ícone e cor. Ícones e cores aceitam também os nomes do app nativo, convertidos para o mais próximo do Web (a resposta diz qual usou): SF Symbols como `sparkle`, `gearshape`, `server.rack`, `bolt`, `doc.text` (→ `sparkles`, `wrench`, `database`, `zap`, `book`); cores `blue`/`cyan`→`sky`, `purple`→`violet`, `pink`/`red`→`rose`, `green`→`emerald`, `yellow`→`amber`, `white`/`charcoal`→`slate`, `midnight`→`indigo`; hex `#RRGGBB` vira a cor do Web mais próxima; um emoji vira o ícone `sparkles` (o Web não o desenha); `default` volta ao padrão. Valor inválido lista as duas formas. `maestri note create` põe a nota à esquerda do seu terminal.

## CLI: PATH, flags e workspaces
Se `maestri` não for encontrado no PATH, use `"$MAESTRI_CLI"` (caminho absoluto do binário, sempre definido no terminal). Flags desconhecidas falham ("Flag desconhecida: --x") — nunca adivinhe uma flag; para um texto que comece com `--`, ponha `--` antes dele (`maestri send "A" -- "--foo"`).

Agentes de OUTROS workspaces (projetos) aparecem no `maestri list` como `Nome @ Workspace`, e o seu próprio endereço aparece na linha `Você:`. ask, send, check, `ask --batch`, connect, dismiss e os comandos de banda aceitam esse endereço:
```
maestri recruit "Hawk" --workspace "Frontend" [--floor "Experiment"] --preset "Claude Code"   # nasce no projeto Frontend, ligado a você
maestri ask "Hawk @ Frontend" "status?"           maestri connect "Local" "Hawk @ Frontend"   # agente↔agente entre projetos
maestri band create "Squad" --workspace "Frontend"   maestri band add "Squad @ Frontend" "Hawk @ Frontend"
```
`ask`/`send`/`check` num agente sem sessão (descarregado, servidor reiniciado) sobem o terminal com o cwd e o comando do nó; se ele acabou de subir, `ask` responde "ainda iniciando; pergunte de novo" (código 3) — repita em alguns segundos; `check` mostra o que já apareceu.

`maestri portal wait "Portal" (@ref|seletor | --text "t" | --url "padrão" | MS) [--timeout S]` espera um elemento visível, um texto, uma URL (substring ou glob com `*`) ou um tempo; estourar o tempo é erro (`maestri: error:`, saída != 0).

Com role, o recruta começa em `.maestri/roles/<id>/`, que traz o prompt em `CLAUDE.md` (claude) e `AGENTS.md` (codex, opencode, agy); com `--dir`/`--floor` o terminal começa onde você pediu e claude/codex recebem o prompt como argumento.

## Limites de segurança dos portais
Por padrão um portal não abre (nem alcança por redirecionamento ou sub-requisição) endereços link-local/metadata de nuvem (169.254.0.0/16, `fd00:ec2::254`, `metadata.google.internal`) nem a API do próprio servidor do Maestri; localhost em outras portas continua livre. `MAESTRI_PORTAL_ALLOW_PRIVATE=1` no servidor libera tudo. Consequência: a própria UI do Maestri Web aberta num portal carrega, mas não alcança a API (mostra "Não foi possível conectar ao servidor"); para testar o Maestri Web por dentro de um portal, suba o servidor com essa variável. `portal upload` só lê arquivos do projeto, dos anexos do chat ou do diretório temporário. Cada portal raiz aceita no máximo 8 popups abertos. Contas: apagar uma conta desafixa (e lista) os presets que a fixavam.

## Avisos e fim do turno
`maestri notify`, lembretes de rotina e andares que mudam para blocked/review/done também viram notificação do sistema na máquina do servidor (se ligado nas Configurações). `maestri ask` só considera o agente "pronto" quando o terminal fica quieto E a tela dele não mostra um indicador de ocupado (`esc to interrupt`, `Working…`/`Thinking…`); `--timeout` continua valendo. Quando um agente de um andar git termina um turno, o servidor procura o PR da branch (`gh`) e avisa se o andar passou a segui-lo. `routine create --terminal "Nome" --floor "Andar"` desambigua terminais de mesmo nome.
