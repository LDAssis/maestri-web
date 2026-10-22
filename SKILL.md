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
