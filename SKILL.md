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

maestri note read "Notas"                                # lê uma nota conectada
maestri note write "Notas" "texto"                       # substitui o conteúdo
maestri note append "Notas" "mais uma linha"             # acrescenta
maestri note create "Decisões" "texto"                   # cria uma nota perto de você, já conectada a você

maestri portal navigate "Preview" "http://localhost:3000"   # só http/https

maestri notify "Deploy concluído"                        # toast para todos os navegadores no projeto

# Somente o nó Maestro (coroa) — outros recebem erro "Apenas o Maestro pode ..."
maestri recruit "QA" --cmd claude --role "Você testa a API e reporta falhas"
maestri dismiss "QA"
```

`maestri --help` e `maestri <comando> --help` mostram o uso.

## Como usar bem
1. Comece com `maestri list` para saber quem são seus vizinhos.
2. Use `send` para delegar sem esperar; `ask` quando precisar da resposta antes de continuar; `check` para acompanhar o progresso de quem está trabalhando.
3. Registre decisões e progresso nas notas conectadas (`note append`) — os humanos veem ao vivo no canvas.
4. `recruit`: com `--role`, o texto do papel vai para `.maestri-roles/<id>.md` (nunca é interpolado no comando); com `--cmd claude` ou `--cmd codex` o arquivo é passado como prompt inicial. O novo agente já nasce conectado a você e com o terminal iniciado.
5. Se for o Maestro: quebre o objetivo em tarefas, recrute especialistas, delegue com `send`/`ask`, acompanhe com `check` e dispense (`dismiss`) quem terminou.

## Face de chat
Os usuários também conversam com você pela **face de chat** do seu nó: a mensagem chega digitada no seu terminal (menções `@Nota` vêm com a dica de como ler). **Quando receber mensagens pela face de chat, responda com `maestri chat reply`** — é o que aparece, renderizado em Markdown, para todos que estão no canvas; a saída crua do terminal vira só um bloco recolhido.

```bash
maestri chat reply "Pronto! Veja o resumo:\n\n- item 1\n- item 2"   # aceita Markdown (tabelas, listas, código)
maestri chat history --last 10                                         # releia o que o usuário pediu
```

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
