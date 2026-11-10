import { SHORTCUTS } from "./shortcuts";

// Conteúdo da Central de Ajuda. Para editar: mexa só neste arquivo.
// Textos aceitam **negrito** (nomes de botões) e `código`.
export type HelpBlock =
  | { t: "p"; text: string }
  | { t: "steps"; items: string[] }
  | { t: "list"; items: string[] }
  | { t: "tip"; text: string }
  | { t: "warn"; text: string }
  | { t: "shortcuts" }
  | { t: "clip"; id: string; caption: string }; // gravação em public/help/<id>.webm

export interface HelpSection {
  id: string; // usado no deep link /?ajuda=<id>
  title: string;
  summary: string;
  adminOnly?: boolean;
  blocks: HelpBlock[];
}

export const HELP_SECTIONS: HelpSection[] = [
  {
    id: "primeiros-passos",
    title: "Primeiros passos",
    summary: "O que é o Maestri Web e como rodar seu primeiro agente.",
    blocks: [
      { t: "clip", id: "primeiros-passos", caption: "Do login ao primeiro prompt: entrar, criar um projeto, abrir um agente e escrever para ele." },
      {
        t: "p",
        text: "O **Maestri Web** é um espaço de trabalho compartilhado onde você e sua equipe colocam agentes de IA (Claude Code, Codex e outros CLIs) lado a lado num **canvas**, cada um num terminal, e fazem eles conversarem entre si e com notas.",
      },
      {
        t: "steps",
        items: [
          "Entre com seu e-mail e senha. Não tem conta? Peça um **link de convite** a um administrador. No primeiríssimo acesso do servidor, a tela pede para criar a conta de administrador.",
          "Crie um projeto: abra o seletor de projetos no topo e clique em **Criar Novo Projeto**. Dê um nome e, se quiser, uma descrição.",
          "No canvas, pressione **A** (ou clique com o botão direito no fundo e escolha **Novo agente**). Dê um título e escolha o preset (por exemplo `claude`).",
          "Clique dentro do terminal do agente e escreva o primeiro prompt. Se preferir um campo de chat, troque a face do nó de **Terminal** para **Chat** no cabeçalho do agente.",
          "Se o CLI ainda não está instalado ou logado, use o botão **CLIs & Logins** (veja a seção de CLIs e contas).",
        ],
      },
      { t: "tip", text: "Quer ver um exemplo antes? Abra a seção **Trabalho em equipe de agentes** para ligar dois agentes por uma nota." },
    ],
  },
  {
    id: "projetos",
    title: "Projetos e membros",
    summary: "Criar, organizar e compartilhar projetos.",
    blocks: [
      { t: "clip", id: "projetos", caption: "Seletor de projetos, organização em grupos e pastas e o modal Membros adicionando alguém." },
      {
        t: "p",
        text: "Cada projeto tem o próprio canvas, terminais, andares e rotinas. Você só vê os projetos em que tem acesso.",
      },
      {
        t: "list",
        items: [
          "**Dono**: quem criou. Gerencia membros, transfere a propriedade e pode excluir o projeto.",
          "**Membro**: usa o projeto por completo (canvas, terminais, arquivos), mas não gerencia membros nem exclui. Pode **Sair do projeto**.",
          "**Administrador**: vê e gerencia todos os projetos. Aparece com o selo \"admin\" nos que não são dele.",
        ],
      },
      { t: "p", text: "O selo **dono**, **membro** ou **admin** aparece ao lado do nome no seletor de projetos." },
      {
        t: "steps",
        items: [
          "Para convidar alguém que já tem conta: seletor de projetos → **Membros…** → busque por nome ou e-mail → **Adicionar**.",
          "Para passar a propriedade: em **Membros…**, clique **Tornar dono** no membro escolhido e confirme. O dono anterior vira membro.",
          "Para sair de um projeto (como membro): **Membros…** → **Sair do projeto**.",
          "Para organizar: seletor → **Organizar grupos e pastas**. Lá você fixa projetos, cria grupos e pastas e move cada projeto para onde quiser.",
          "Para excluir (dono ou admin): **Configurações** → aba do projeto → **Excluir projeto…**, ou o ícone de lixeira em **Organizar grupos e pastas**. A exclusão apaga canvas, notas, andares e rotinas e não dá para desfazer.",
        ],
      },
      { t: "tip", text: "Se alguém te remover de um projeto que você está olhando, aparece o aviso \"Você não tem mais acesso a este projeto\" e o app troca para outro projeto." },
    ],
  },
  {
    id: "canvas",
    title: "Canvas",
    summary: "Navegar, criar nós e ligar tudo.",
    blocks: [
      { t: "clip", id: "canvas", caption: "Mover e dar zoom no canvas, buscar com Ctrl+K e criar uma nota pelo menu de contexto." },
      {
        t: "steps",
        items: [
          "**Navegar**: arraste o fundo para mover, use a roda do mouse (ou pinça) para zoom. O **minimapa** no canto inferior direito mostra onde você está; **F** enquadra tudo.",
          "**Buscar**: **Ctrl/⌘ K** abre a paleta. Digite parte do título, conteúdo ou papel de um nó para ir até ele, ou escolha uma ação (Novo agente, Nova nota, Exportar partitura…).",
          "**Criar**: botão direito no fundo abre o menu de contexto (Novo agente, Nova nota, Novo fichário, Novo portal, Nova árvore de arquivos, Novo diff, Exportar/Importar partitura).",
          "**Ações num nó**: botão direito sobre ele para **Duplicar**, **Exportar partitura**, mudar a cor ou **Apagar**.",
          "**Ligar nós**: arraste de uma bolinha de conexão (no topo/base do nó) até outro nó. A seta indica quem enxerga quem. Entre andares diferentes só dá para ligar agente com agente.",
        ],
      },
      { t: "p", text: "Tipos de nó:" },
      {
        t: "list",
        items: [
          "**Agente** (terminal): um CLI de IA rodando, com face de terminal ou de chat.",
          "**Nota**: texto livre que agentes e pessoas leem e escrevem. Serve de contrato entre agentes.",
          "**Fichário**: pilha de notas organizadas.",
          "**Portal**: navegador embutido que os agentes controlam (e você também).",
          "**Desenho**: ferramentas de desenho (caneta, retângulo, elipse, seta, texto, borracha) para anotar o canvas. Abra por **Ferramentas de desenho** na paleta.",
          "**Diff**: mostra as mudanças de um andar. Também abre pelo botão do andar no rodapé do agente.",
          "**Árvore de arquivos**: navega e baixa os arquivos do projeto.",
          "**Banda**: grupo de agentes onde todo mundo fala com todo mundo (criada por um agente Maestro; veja Trabalho em equipe).",
        ],
      },
      { t: "tip", text: "**Exportar partitura** salva um conjunto de nós (a seleção ou tudo) para reaproveitar em outro projeto com **Importar partitura**." },
    ],
  },
  {
    id: "terminais",
    title: "Terminais de agente",
    summary: "CLI, modelo, copiar/colar, anexos e sessão.",
    blocks: [
      { t: "clip", id: "terminais", caption: "Selecionar e copiar texto do terminal e anexar um arquivo na face de Chat." },
      {
        t: "steps",
        items: [
          "**Escolher CLI e modelo**: ao criar o agente você escolhe o preset (CLI), o **Modelo** (quando o CLI permite) e um **Role** opcional. Depois, o seletor de modelo no cabeçalho do nó troca o modelo; o terminal reinicia e retoma a sessão.",
          "**Copiar**: selecione o texto e use **Ctrl+C** (com texto selecionado) ou **Ctrl+Shift+C**. Sem seleção, **Ctrl+C** continua sendo a interrupção do programa. Também há o botão **Copiar seleção** e o menu do botão direito.",
          "**Colar**: **Ctrl+V** ou **Ctrl+Shift+V**, o botão **Colar** ou o menu do botão direito. Sem HTTPS o navegador não deixa ler a área de transferência: aparece uma caixa para você colar com Ctrl+V.",
          "**Anexos**: na face de **Chat**, use o clipe (**Anexar arquivo**) ou cole uma imagem direto no campo. O botão **@** menciona um nó conectado.",
          "**Reiniciar sessão**: ícone de seta circular no rodapé do agente. Por padrão o terminal retoma a conversa anterior do CLI.",
          "**Limpar tela**: ícone de limpar na barra do terminal.",
        ],
      },
      {
        t: "p",
        text: "**Tamanho compartilhado**: se várias pessoas estão com o mesmo terminal aberto, ele usa o menor tamanho entre elas. Se o texto parecer quebrado, veja Solução de problemas.",
      },
      { t: "p", text: "O rodapé mostra o estado (**Conectando…**, **Online**, **Offline**, **Sessão encerrada**) e o ícone do CLI maestri lista os comandos disponíveis naquele terminal." },
      { t: "tip", text: "Os botões de comando rápido da barra do terminal são os presets. Dá para personalizar o comando padrão e os botões em **Configurações**." },
    ],
  },
  {
    id: "equipe",
    title: "Trabalho em equipe de agentes",
    summary: "Notas como contrato, ligações, CLI maestri, modo Maestro.",
    blocks: [
      { t: "clip", id: "equipe", caption: "Ligando uma nota a um agente: arraste da bolinha de conexão até o outro nó." },
      {
        t: "p",
        text: "Agentes se enxergam quando estão **ligados** no canvas. Um agente só fala com quem está conectado a ele. Notas ligadas a um agente ele consegue ler e escrever.",
      },
      {
        t: "steps",
        items: [
          "Crie uma **nota** com o combinado (objetivo, arquivos, critérios de pronto).",
          "Ligue a nota aos agentes que devem segui-la e ligue os agentes entre si.",
          "Peça a um agente: \"leia a nota X e implemente\". Ele usa `maestri note read \"X\"`.",
          "Para delegar, o agente usa `maestri ask \"Nome\" \"pedido\"`. O comando espera o outro agente terminar e devolve a resposta.",
        ],
      },
      { t: "p", text: "Comandos do CLI **maestri** que os agentes usam (o ícone do CLI em cada terminal mostra a lista):" },
      {
        t: "list",
        items: [
          "`maestri list`: nós conectados.",
          "`maestri ask \"Nome\" \"texto\"`: pergunta e espera a resposta.",
          "`maestri ask --batch '{\"A\":\"...\",\"B\":\"...\"}'`: pergunta a vários agentes em paralelo e devolve tudo junto.",
          "`maestri check \"Nome\"`: lê o terminal atual do agente. `maestri send`: escreve no terminal dele.",
          "`maestri note read|write|edit|create \"Nome\"`: lê e edita notas.",
          "`maestri notify \"texto\"`: avisa todos no projeto.",
        ],
      },
      {
        t: "p",
        text: "**Ask back**: em tarefas longas, peça ao agente para responder quando terminar com `maestri ask \"Seu Nome\" \"<resultado>\"`. A resposta chega completa, em vez de cortada na tela.",
      },
      {
        t: "p",
        text: "**Modo Maestro**: clique em **Tornar Maestro** no cabeçalho de um agente. Ele vira orquestrador e ganha `maestri recruit` / `dismiss` para criar e dispensar colegas, e `maestri band` para agrupá-los. Só marque um Maestro quando quiser que ele monte a equipe.",
      },
      {
        t: "list",
        items: [
          "**Roles**: botão **Roles** no topo do canvas. Um role é o prompt inicial de um agente; podem ser do projeto ou globais. Qualquer pessoa cria roles do projeto e usa os globais, mas só administradores criam, editam ou apagam roles globais. Escolha o role ao criar o agente.",
          "**Presets**: definem CLI, comando, ícone e cor. Edite em **Configurações** (aba do projeto ou global).",
          "**Bandas**: nó que reúne vários agentes; todo membro alcança os outros. A criação e as mudanças são feitas por um Maestro (`maestri band create|add|remove|dissolve`). Apagar o nó dissolve a banda.",
        ],
      },
      { t: "tip", text: "Combine o trabalho numa nota **antes** de dividir tarefas entre agentes. Evita retrabalho e conflito." },
    ],
  },
  {
    id: "andares",
    title: "Andares (worktrees)",
    summary: "Trabalho isolado em branches, PR e aterrissar.",
    blocks: [
      { t: "clip", id: "andares", caption: "Criar um andar para o agente e alternar entre os andares." },
      {
        t: "p",
        text: "Um **andar** é uma cópia isolada do repositório (git worktree) numa branch própria. Agentes de andares diferentes não pisam nos arquivos uns dos outros, então dá para fazer mudanças arriscadas em paralelo.",
      },
      {
        t: "steps",
        items: [
          "Para isolar um agente existente: no rodapé do agente, clique **Criar andar**.",
          "Para criar um agente já num andar: marque **Criar em andar isolado (git worktree)** em Novo agente.",
          "Para criar andares: clique em **Andar: <nome>** no canvas (seletor de andares), preencha o **nome do andar** (ou um **pull request** por número/link, que usa o `gh`) e clique **Criar andar**. Na face de chat, o botão **Novo andar** faz o agente criar um andar para a tarefa que você descrever.",
          "Para ver o que mudou: **Ver diff do andar** (rodapé do agente) ou a aba **Worktrees & Diffs**.",
          "Para fechar: no seletor de andares, **Land** (aterrissar) fecha o andar mantendo a branch e, se quiser, mescla em outra branch. **Unload** descarrega o andar da memória (não pode ser o que você está usando) e **Delete** apaga.",
          "Se o andar tem PR, o seletor mostra o estado dos checks e o botão para mesclar (merge, squash ou rebase). Com checks falhando ou pendentes, pede confirmação.",
        ],
      },
      { t: "tip", text: "Sempre revise o diff antes de aterrissar. Mudança arriscada? Faça num andar." },
    ],
  },
  {
    id: "rotinas",
    title: "Rotinas",
    summary: "Agendar comandos, prompts e lembretes.",
    blocks: [
      { t: "clip", id: "rotinas", caption: "Criando uma rotina: nome, alvo, mensagem e agendamento." },
      {
        t: "steps",
        items: [
          "Abra a aba **Rotinas** no topo (ou o ícone de relógio na barra lateral).",
          "Clique **Nova rotina** e dê um nome.",
          "Escolha o alvo: um agente ou **Lembrete (sem terminal, só aviso)**.",
          "Escolha o tipo: **Comando (escreve no terminal)** ou **Prompt (para o agente)**.",
          "Defina quando: **A cada…** (ex.: `30m`, `2h`, `1h30m`), **Diário às**, **Semanal** (com os dias) ou **Uma vez**. Os horários são os do servidor.",
          "Salve. Use **Rodar agora** para testar e o controle **Ativa** para pausar.",
        ],
      },
      { t: "tip", text: "Dá para limitar quantas vezes a rotina roda e configurar um comando que roda antes. Use para auditorias noturnas e lembretes recorrentes." },
    ],
  },
  {
    id: "arquivos",
    title: "Arquivos e downloads",
    summary: "Árvore de arquivos, visualizar e baixar em zip.",
    blocks: [
      { t: "clip", id: "arquivos", caption: "Abrir a árvore de arquivos, ver um arquivo e baixar em zip." },
      {
        t: "steps",
        items: [
          "Crie uma **Nova árvore de arquivos** pelo menu do canvas (ou pela paleta).",
          "Use **Filtrar por nome…** para achar um arquivo e o ícone de recarregar para atualizar a lista. Pastas com mudanças têm um ponto âmbar.",
          "Clique num arquivo para ver o conteúdo no visualizador; feche com o **X**.",
          "Para baixar: o ícone de download ao lado de uma pasta gera um **.zip** da pasta; ao lado de um arquivo baixa o arquivo; no topo, **Baixar projeto (.zip)** baixa tudo.",
          "A seta ao lado do botão de projeto abre as **Opções do download** (por exemplo, incluir ou não arquivos como `.env`).",
        ],
      },
      { t: "warn", text: "Arquivos `.env` ficam de fora do zip por padrão porque costumam guardar segredos. Só inclua se tiver certeza." },
      { t: "p", text: "Pastas pesadas (como `node_modules`) aparecem como não listadas." },
    ],
  },
  {
    id: "clis-contas",
    title: "CLIs e contas de assinatura",
    summary: "Instalar, logar, várias contas e painel de uso.",
    blocks: [
      {
        t: "steps",
        items: [
          "Abra **CLIs & Logins** (ícone de chave na barra lateral ou botão no topo).",
          "Escolha o CLI na lista. Se não estiver instalado, clique **Instalar**.",
          "Clique **Entrar** e siga o passo a passo: o app mostra um link (e às vezes um código) para autorizar a conta no navegador.",
          "Para usar **outra conta** do mesmo CLI, use **Nova conta**, dê um nome e faça o login nela. Cada conta tem um diretório de configuração isolado; as contas aparecem em **Configurações** (**Contas de CLI**) e um Maestro pode recrutar um agente numa conta com `maestri recruit --account`.",
          "**Sair** desconecta a conta (pede confirmação).",
        ],
      },
      { t: "warn", text: "Instalar CLIs, fazer login e criar ou apagar contas é restrito a **administradores**: para os demais, o botão **CLIs & Logins** nem aparece e **Contas de CLI** (em Configurações) é só leitura. Se precisar de um CLI ou conta nova, peça a um admin. O Padrão Global das Configurações também é só dos administradores." },
      {
        t: "p",
        text: "**Painel de uso**: o botão com o ícone de medidor no canto inferior direito do canvas mostra a maior porcentagem de uso da sessão de 5 h entre as contas. Clique para ver, por conta, a **Sessão (5 h)** e a **Semana (7 d)** com quando renovam. Contas só aparecem depois que um agente Claude (assinatura Pro/Max) responde no canvas; outros CLIs ainda não informam cota.",
      },
      {
        t: "p",
        text: "**Quem pode usar cada conta**: o login original do servidor vira a conta **Padrão** (claude, codex e Gemini / Antigravity), liberada a todo administrador. Um admin libera as demais contas **por usuário**, e um projeto só usa as contas liberadas ao seu **dono**. Se nenhuma estiver liberada, o terminal avisa \"Nenhuma conta de assinatura liberada para este projeto\": peça a um admin.",
      },
      { t: "tip", text: "A conta **Gemini / Antigravity** é uma só e vale para os **dois** CLIs (Gemini CLI e Antigravity), porque eles dividem a mesma configuração. Logar num já vale para o outro, e liberar ou retirar essa conta afeta os dois." },
      { t: "warn", text: "Quando um admin **retira** uma conta de alguém, os terminais dos projetos dessa pessoa que a usavam são **reiniciados** e você vê um aviso no canvas. A conversa é retomada, mas salve o que estiver em andamento." },
      { t: "tip", text: "Verde é abaixo de 70%, âmbar de 70 a 90% e vermelho acima de 90%. O selo **desatualizado** indica dado com mais de 30 minutos." },
    ],
  },
  {
    id: "colaboracao",
    title: "Colaboração em tempo real",
    summary: "Presença, cursores e quem está onde.",
    blocks: [
      { t: "clip", id: "colaboracao", caption: "Duas pessoas no mesmo projeto: o cursor da outra aparece no seu canvas." },
      {
        t: "list",
        items: [
          "No topo aparecem os **avatares** de quem está online. Clique num para ir até o projeto e o lugar do canvas onde a pessoa está.",
          "No canvas você vê o **cursor** das outras pessoas e um anel nos nós que elas estão usando.",
          "Nos terminais aparece quem está digitando.",
          "Você recebe avisos rápidos de presença das outras pessoas.",
          "Alterações no canvas (mover, criar, apagar nós) aparecem para todos ao mesmo tempo.",
        ],
      },
      { t: "p", text: "Seu nome e cor vêm da sua conta. Mude no **menu do perfil** (clique no seu avatar)." },
      { t: "tip", text: "Vários usuários no mesmo terminal limitam o tamanho dele ao menor deles. Combinem quem digita." },
    ],
  },
  {
    id: "administracao",
    title: "Administração",
    summary: "Convites, usuários, senhas e acesso a projetos.",
    adminOnly: true,
    blocks: [
      { t: "clip", id: "administracao", caption: "Gerar um link de convite e dar acesso a projetos para um usuário." },
      { t: "p", text: "Abra o ícone de escudo na barra lateral: **Usuários e acessos**." },
      {
        t: "steps",
        items: [
          "**Convidar**: aba **Convites** → (opcional) escreva uma anotação → **Gerar link de convite** → **Copiar** e envie. O link vale **1 uso** e expira em **7 dias**. Você pode **Revogar** convites pendentes.",
          "**Desativar/reativar**: aba **Usuários**, ícone de usuário. A pessoa não consegue entrar, mas continua dona/membro dos projetos.",
          "**Promover/rebaixar**: ícone de escudo na linha do usuário. Sempre deve existir ao menos um administrador ativo.",
          "**Redefinir senha**: ícone de chave gera um link de redefinição (1 uso, 24 h). Envie à pessoa. As sessões antigas dela são encerradas.",
          "**Dar acesso a projetos**: botão **Projetos** na linha do usuário → marque os projetos em que a pessoa será membro → **Salvar projetos**. Onde ela é dona fica marcado e travado.",
          "**Liberar contas de assinatura**: botão **Contas** na linha do usuário → marque as contas (Claude, Codex, Gemini / Antigravity) que ele pode usar → **Salvar contas**. Retirar uma conta reinicia os terminais que a usavam. Administradores usam todas.",
          "**Excluir usuário**: ícone de lixeira; confirme digitando o e-mail. Os projetos dele passam para você.",
        ],
      },
      { t: "warn", text: "Você não pode desativar, excluir nem rebaixar a si mesmo." },
      { t: "p", text: "**Isolamento**: cada projeto roda num usuário próprio do sistema, então um agente não lê outros projetos, os dados do Maestri nem age como admin. Projetos com **pasta externa** (só admin cria) rodam como root e mostram o selo âmbar **sem isolamento**: use com cuidado." },
    ],
  },
  {
    id: "atalhos",
    title: "Atalhos de teclado",
    summary: "Teclas rápidas do canvas.",
    blocks: [
      { t: "clip", id: "atalhos", caption: "A tecla ? abre esta lista; Ctrl+K busca qualquer nó." },
      { t: "shortcuts" },
      { t: "p", text: "Os atalhos de letra só funcionam quando o foco não está num campo de texto ou terminal." },
      { t: "tip", text: "Pressione **?** a qualquer momento no canvas para abrir esta seção." },
    ],
  },
  {
    id: "dicas",
    title: "Dicas para usar melhor",
    summary: "Boas práticas e erros comuns.",
    blocks: [
      {
        t: "list",
        items: [
          "**Um agente por responsabilidade** (backend, frontend, revisão). Agentes focados erram menos.",
          "**Contrato em nota antes de dividir o trabalho**: objetivo, arquivos, critérios de pronto.",
          "**Peça ask back** em tarefas longas, para receber o resultado completo.",
          "**Use andares** para mudanças arriscadas ou paralelas.",
          "**Revise o diff antes de aterrissar.**",
          "**Nomeie bem os nós**: os agentes se chamam pelo nome (`maestri ask \"Backend\" ...`).",
        ],
      },
      {
        t: "list",
        items: [
          "Erro comum: dois agentes editando os mesmos arquivos no repositório principal. Solução: um andar para cada.",
          "Erro comum: esquecer de ligar os nós. Sem ligação, o agente não enxerga a nota nem o colega.",
          "Erro comum: reenviar o prompt quando o `ask` demora. Use `maestri check` para acompanhar e espere.",
        ],
      },
      { t: "tip", text: "Perdeu um nó no meio do canvas? **Ctrl/⌘ K** acha pelo título; **F** enquadra tudo." },
    ],
  },
  {
    id: "problemas",
    title: "Solução de problemas",
    summary: "O que fazer quando algo não funciona.",
    blocks: [
      {
        t: "list",
        items: [
          "**Terminal embaralhado ou com texto quebrado**: redimensione o nó um pouco ou recarregue a página. O tamanho segue o menor cliente conectado; feche o terminal em quem não está usando.",
          "**Sessão expirada**: o app volta sozinho para a tela de login. Entre de novo. Se acontecer logo após uma redefinição de senha, é esperado: as sessões antigas são encerradas.",
          "**Agente travado**: use `maestri check \"Nome\"` de outro agente para ver o que ele está fazendo. Se não responde, clique **Reiniciar sessão** no rodapé do nó (a conversa é retomada).",
          "**Sem acesso a um projeto**: peça ao dono (ou a um administrador) para te adicionar em **Membros…**.",
          "**\"Nenhuma conta de assinatura liberada\" no terminal**: o dono do projeto não tem conta liberada. Peça a um admin em **Usuários e acessos → Contas**.",
          "**Terminal reiniciou sozinho com aviso no canvas**: um admin retirou a conta que ele usava. Reabra a conversa com outra conta liberada.",
          "**Selo \"sem isolamento\" no projeto**: a pasta é externa e o terminal roda como root. É esperado; evite rodar agentes de terceiros ali.",
          "**Cota esgotada**: abra o **painel de uso** (canto inferior direito do canvas). Se a sessão de 5 h está em vermelho, espere renovar ou troque o agente para outra conta.",
          "**Servidor indisponível**: aparece \"Não foi possível conectar ao servidor\". Use **Tentar novamente**; se persistir, avise um administrador.",
        ],
      },
      { t: "tip", text: "O painel de uso só mostra cota depois que um agente Claude responde. Se está vazio, isso é normal." },
    ],
  },
];

export { SHORTCUTS };
