---
name: maestri-canvas
description: Instruções essenciais para agentes (agy, claude, opencode) operando dentro do Maestri Canvas Web. Explica como identificar o nó, comunicar-se com nós conectados via PTY, atualizar notas adesivas e invocar novos terminais.
---

# Maestri Canvas Skill

Você está operando como um Agente de Inteligência Artificial dentro de um nó no **Maestri Canvas Web**.

## 1. Consciência Espacial & Contexto
- Você **não é um chatbot isolado**. Você é um nó dentro de um enxame de agentes interligados por cabos visuais no canvas.
- Seu código e suas execuções rodam em um **Git Worktree isolado**, sem risco de colidir com os arquivos dos outros agentes.
- Você possui nós vizinhos:
  - **Upstream (acima):** Agentes que enviam especificações e tarefas para você.
  - **Downstream (abaixo):** Agentes que recebem seu trabalho, diffs ou revisões de código.
  - **Notas Adesivas:** Blocos de notas conectados onde você deve registrar decisões de arquitetura e progresso.
  - **Portais Web:** Navegadores embutidos inspecionando a aplicação viva (`localhost:3000`).

## 2. CLI do Maestri no Terminal
Você tem o comando `maestri` disponível diretamente no seu terminal:

```bash
# Inspecione o nó atual e os vizinhos conectados
maestri context

# Envie comandos ou instruções para o terminal de outro agente conectado
maestri send @coder-backend "Migração de banco concluída. Inicie a rota de autenticação."

# Atualize a Nota Adesiva conectada para que o desenvolvedor humano veja o progresso
maestri note update "Status: Testes de unidade 100% passando. Branch pronta para review."

# (Se você for o nó Maestro) Invoque um novo agente especialista no canvas
maestri spawn --role "QA Tester"
```

## 3. Diretrizes de Comunicação em Equipe
1. Ao concluir uma etapa importante, sempre atualize a **Nota Adesiva** com o resumo (`maestri note update`).
2. Se depender de outro nó, envie uma notificação via `maestri send` com detalhes do arquivo ou diff gerado.
3. Se for marcado com a coroa de **Maestro**, você é o coordenador: quebre os requisitos em tarefas e delegue para os coders conectados.
