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
