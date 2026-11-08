#!/usr/bin/env bash
# Agente de mentira para gravar a ajuda: não chama nenhuma IA nem conta real
NAME="${FAKE_AGENT_NAME:-Claude Code}"
printf '\033[2J\033[3J\033[H'
printf '\033[38;5;173m╭──────────────────────────────────────────╮\033[0m\n'
printf '\033[38;5;173m│\033[0m ✻ Bem-vindo ao \033[1m%s\033[0m (demo)         \033[38;5;173m│\033[0m\n' "$NAME"
printf '\033[38;5;173m╰──────────────────────────────────────────╯\033[0m\n\n'
while true; do
  printf '\033[2m>\033[0m '
  IFS= read -r line || exit 0
  [ -z "$line" ] && continue
  sleep 0.6
  printf '\033[36m● Lendo arquivos do projeto…\033[0m\n'; sleep 0.9
  printf '\033[36m● Analisando src/carrinho.tsx e src/preco.ts\033[0m\n'; sleep 0.9
  printf '\033[32m✔ Entendi o pedido:\033[0m %s\n' "$line"; sleep 0.5
  printf '  1. Criar o componente de resumo do pedido\n'; sleep 0.4
  printf '  2. Formatar o preço com duas casas decimais\n'; sleep 0.4
  printf '  3. Rodar os testes\n\n'; sleep 0.5
  printf '\033[32m✔ Pronto! Alterações aplicadas em 2 arquivos.\033[0m\n\n'
done
