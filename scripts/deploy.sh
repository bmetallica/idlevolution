#!/usr/bin/env bash
# Baut das Frontend, aktualisiert die Container und spielt das Web-Bundle ein —
# der bisher manuelle Vierschritt, der mehrfach am falschen cwd scheiterte.
#
#   ./scripts/deploy.sh          # Web + App (Server-Code) neu bauen & deployen
#   ./scripts/deploy.sh --web    # nur Frontend neu bauen & einspielen (kein Rebuild)
#   ./scripts/deploy.sh --full   # zusätzlich ai-worker neu bauen
#
# Läuft IMMER vom Projekt-Root (cd unten) — `docker compose cp web/dist/.` scheitert
# sonst mit „lstat web/web: no such file or directory".
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="${1:-app}"

echo "[deploy] 1/4 Frontend bauen (web/dist) …"
( cd web && npm run build )

if [ "$MODE" != "--web" ]; then
  SERVICES="app"
  [ "$MODE" = "--full" ] && SERVICES="app ai-worker"
  echo "[deploy] 2/4 Container bauen & starten ($SERVICES) …"
  docker compose up -d --build $SERVICES
else
  echo "[deploy] 2/4 (nur Web) — kein Container-Rebuild"
fi

echo "[deploy] 3/4 Web-Bundle in den App-Container kopieren …"
docker compose cp web/dist/. app:/app/public/

# Healthz-Gate: warten, bis der Server wieder antwortet (max ~30 s)
PORT="$(grep -E '^APP_PORT=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"')"
PORT="${PORT:-8420}"
echo "[deploy] 4/4 Warte auf /healthz (Port $PORT) …"
for i in $(seq 1 30); do
  if curl -fsS "http://localhost:$PORT/healthz" >/dev/null 2>&1; then
    echo "[deploy] ✓ App gesund — $(curl -fsS "http://localhost:$PORT/healthz")"
    exit 0
  fi
  sleep 1
done
echo "[deploy] ⚠ /healthz antwortete nicht rechtzeitig — 'docker compose logs app' prüfen." >&2
exit 1
