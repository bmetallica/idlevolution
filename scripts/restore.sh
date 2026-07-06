#!/usr/bin/env bash
# Stellt ein Backup wieder her: ./scripts/restore.sh data/backups/<TIMESTAMP>
# Überschreibt DB-Zustand und generierte Inhalte. App danach neu starten.
set -euo pipefail
cd "$(dirname "$0")/.."

DIR="${1:-}"
if [ -z "$DIR" ] || [ ! -d "$DIR" ]; then
  echo "Nutzung: $0 data/backups/<TIMESTAMP>"
  echo "Verfügbar:"; ls -1dt data/backups/*/ 2>/dev/null | head
  exit 1
fi

envval() { grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'; }
PGUSER="$(envval POSTGRES_USER)"; PGUSER="${PGUSER:-idle}"
PGDB="$(envval POSTGRES_DB)"; PGDB="${PGDB:-idlevolution}"

read -r -p "Backup '$DIR' wirklich einspielen? DB + Inhalte werden überschrieben. [j/N] " ok
[ "$ok" = "j" ] || { echo "abgebrochen"; exit 0; }

echo "[restore] Inhalte"
rm -rf data/content
tar -xzf "$DIR/content.tar.gz" -C data

echo "[restore] Postgres"
gunzip -c "$DIR/db.sql.gz" | docker compose exec -T db psql -U "$PGUSER" -d "$PGDB" -q

echo "[restore] App neu starten…"
docker compose restart app
echo "[restore] fertig."
