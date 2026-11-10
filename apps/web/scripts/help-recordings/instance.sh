#!/bin/bash
# Instância ISOLADA de gravação (servidor :4100 + web :3100) a partir de uma cópia do código em /tmp/maestri-rec/src.
# Nunca toca na produção (:4000/:3000, /opt/maestri-web/.maestri_data). Uso: instance.sh start|stop|reset|clean
# Pré-requisito: o código já está em /tmp/maestri-rec/src (veja README.md) e /opt/maestri-web/node_modules existe.
set -e
BASE=/tmp/maestri-rec
NM=/opt/maestri-web/node_modules

stop() {
  pkill -f "$BASE/src/apps/server" 2>/dev/null || true
  pkill -f "$BASE/src/apps/web" 2>/dev/null || true
  # processos filhos das portas de gravação
  for p in 4100 3100; do
    pid=$(ss -ltnp 2>/dev/null | grep ":$p " | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1)
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
}

fresh_data() {
  rm -rf "$BASE/repo" "$BASE/projects" "$BASE/home"
  mkdir -p "$BASE/repo" "$BASE/projects" "$BASE/home" "$BASE/bin" "$BASE/out"
  (cd "$BASE/repo" && git init -q && git config user.email demo@example.com && git config user.name Demo \
    && echo "# Demo" > README.md && git add -A && git commit -qm inicial)
}

start() {
  export PATH="$BASE/bin:$PATH"   # "claude" aqui é um script de mentira: nenhuma IA ou conta real
  export HOME="$BASE/home"
  (cd "$BASE/src/apps/server" && PORT=4100 HOST=127.0.0.1 REPO_PATH="$BASE/repo" MAESTRI_PROJECTS_DIR="$BASE/projects" \
    MAESTRI_TOKEN=rec-demo-token-2026 MAESTRI_DESKTOP_NOTIFY=0 setsid nohup "$NM/.bin/tsx" src/index.ts > "$BASE/server.log" 2>&1 < /dev/null &)
  (cd "$BASE/src/apps/web" && NEXT_PUBLIC_API_URL=http://127.0.0.1:4100 NEXT_TELEMETRY_DISABLED=1 \
    setsid nohup "$NM/.bin/next" dev -H 127.0.0.1 -p 3100 > "$BASE/web.log" 2>&1 < /dev/null &)
  for i in $(seq 1 60); do curl -sf http://127.0.0.1:4100/api/health >/dev/null && break; sleep 1; done
  echo "instância de gravação no ar (server :4100, web :3100)"
}

case "$1" in
  start) start ;;
  stop) stop ;;
  reset) stop; sleep 1; fresh_data; start ;;
  clean) stop; sleep 1; rm -rf "$BASE"; echo "removido $BASE" ;;
  *) echo "uso: $0 start|stop|reset|clean"; exit 1 ;;
esac
