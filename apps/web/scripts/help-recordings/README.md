# Gravações da Central de Ajuda

Os clipes de `public/help/<id>.webm` (+ `<id>.jpg` de poster) são **gravações reais da tela** do Maestri Web, feitas com
Playwright contra uma instância **isolada** (nunca a de produção), com dados fictícios e um agente de mentira.

## Arquivos
- `instance.sh`: sobe/derruba a instância de gravação (servidor `:4100`, web `:3100`) a partir de `/tmp/maestri-rec/src`.
- `seed.mjs`: cria usuários (Ana Admin, Bruno, Carla Dev), projetos, notas, agentes e repositórios git de demonstração.
- `fake-claude.sh`: vira o comando `claude` no PATH da instância (imprime uma conversa de agente; não chama IA nem conta real).
- `record.mjs`: roda os clipes (`node record.mjs [id ...]`), converte com ffmpeg para WebM VP9 sem áudio e gera o poster.

## Como regravar (no container de desenvolvimento)
1. Copie o código atual para a pasta de gravação (não use o `.next` de produção):
   ```bash
   tar --exclude=.git --exclude=node_modules --exclude=.next --exclude=.maestri_data -czf /tmp/rec-src.tgz .
   ssh root@HOST 'rm -rf /tmp/maestri-rec && mkdir -p /tmp/maestri-rec/{src,bin,out}'
   scp /tmp/rec-src.tgz root@HOST:/tmp/maestri-rec/
   ssh root@HOST 'cd /tmp/maestri-rec/src && tar --no-same-owner -xzf ../rec-src.tgz && ln -s /opt/maestri-web/node_modules node_modules'
   scp apps/web/scripts/help-recordings/fake-claude.sh root@HOST:/tmp/maestri-rec/bin/claude
   ssh root@HOST 'chmod +x /tmp/maestri-rec/bin/claude'
   ```
2. Zere os dados, suba a instância e popule:
   ```bash
   cd /tmp/maestri-rec/src/apps/web/scripts/help-recordings
   ./instance.sh reset && node seed.mjs
   ```
3. Grave (todos, ou só alguns ids) e copie para o repositório:
   ```bash
   node record.mjs                 # ou: node record.mjs canvas atalhos
   scp 'root@HOST:/tmp/maestri-rec/out/*.{webm,jpg}' apps/web/public/help/
   ```
4. Limpe: `./instance.sh clean` (derruba tudo e apaga `/tmp/maestri-rec`).

`record.mjs` precisa de `playwright-core` (em `/opt/maestri-web/node_modules`), do Chromium em `~/.cache/ms-playwright` e do `ffmpeg`.
Se a interface mudar, ajuste os seletores do clipe correspondente em `record.mjs`. Se um clipe falhar, ele salva `<id>-erro.png` em `OUT`.

Alvo: 8–20 s por clipe, menos de 1,5 MB cada, menos de 15 MB no total.
