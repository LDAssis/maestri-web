# Maestri Web 🎼

> O canvas infinito para orquestração de agentes de IA na web, com isolamento por Git Worktrees para equipes de desenvolvimento.

Inspirado no [Maestri](https://www.themaestri.app), esta versão traz a experiência do canvas infinito e orquestração de enxames de agentes para o navegador, permitindo que vários desenvolvedores trabalhem simultaneamente no mesmo projeto sem risco de colisão de arquivos ou conflitos de merge.

---

## 🚀 Principais Recursos

- **Canvas Infinito com React Flow:** Mova, redimensione e organize seus agentes, notas adesivas e portais web espacialmente.
- **Terminais ConPTY Reais:** Cada nó de agente executa uma sessão real de pseudo-terminal (ConPTY) com streaming via WebSockets e xterm.js.
- **Suporte Nativo a CLIs de IA:** Invoque ferramentas como `agy` (Antigravity), `claude` (Anthropic) e `opencode` com botões rápidos ou via linha de comando.
- **Duas Faces por Nó:** Alterne com 1 clique entre o **Terminal ConPTY** e a **Face de Chat** (com compositor `@` mention).
- **Nó Maestro (👑):** Marque qualquer agente como Maestro da equipe para coordenar, delegar tarefas e invocar novos agentes dinamicamente.
- **Notas Adesivas (Sticky Notes):** Blocos de notas conectáveis onde agentes registram decisões de arquitetura e progresso sozinhos.
- **Portais Web Embutidos:** Navegador com inspeção de DOM integrado ao canvas para os agentes testarem a aplicação em tempo real.
- **Isolamento via Git Worktrees:** Cada desenvolvedor e agente opera em branches e diretórios paralelos (`.worktrees/`).
- **Multi-Projetos:** Alterne entre diferentes projetos com configurações, telas e enxames de agentes totalmente isolados.
- **Skill Oficial (`SKILL.md`):** Fornece aos agentes consciência espacial do canvas e ferramentas CLI (`maestri context`, `maestri send`, `maestri note update`).

---

## 🛠️ Tecnologias Utilizadas

- **Frontend:** Next.js (App Router), React 18, Tailwind CSS, `@xyflow/react` (React Flow), `@xterm/xterm`, Lucide Icons.
- **Backend:** Fastify, `@fastify/websocket`, `node-pty` (Windows ConPTY), `simple-git`.
- **Linguagem:** TypeScript em 100% da base.

---

## 🏁 Como Rodar Localmente

### Pré-requisitos
- Node.js >= 18
- Git instalado (Git Bash recomendado no Windows)

### 1. Clonar o repositório
```bash
git clone https://github.com/LDAssis/maestri-web.git
cd maestri-web
```

### 2. Instalar dependências
```bash
# Servidor Fastify (Backend)
cd apps/server
npm install

# Aplicação Web (Next.js)
cd ../web
npm install
```

### 3. Iniciar o projeto
Abra dois terminais:

**Terminal 1 (Backend - porta 4000):**
```bash
cd apps/server
npm run dev
```

**Terminal 2 (Frontend - porta 3000):**
```bash
cd apps/web
npm run dev
```

Acesse: **[http://localhost:3000](http://localhost:3000)**

### Modo colaborativo
Para vários usuários na mesma rede usarem o mesmo canvas:

```bash
# Backend: expõe na rede (HOST não-loopback exige MAESTRI_TOKEN)
cd apps/server
HOST=0.0.0.0 MAESTRI_TOKEN=um-segredo-forte npm run dev

# Frontend: escuta em todas as interfaces
cd apps/web
npm run dev:lan
```

Acesse por **http://&lt;ip-da-maquina&gt;:3000**. Cada pessoa informa o token e escolhe nome e cor na primeira visita. Se a API estiver em outro endereço, defina `NEXT_PUBLIC_API_URL`. `GET /api/health` é público; as demais rotas `/api/*` exigem `Authorization: Bearer <token>` e os WebSockets, `?token=<token>`.

---

## 📜 Licença
Distribuído sob a licença MIT.
