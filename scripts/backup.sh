#!/usr/bin/env bash
# Sichert Spielzustand (Postgres) + generierte KI-Inhalte rotierend nach data/backups/.
# Vor der nächtlichen Generierung ausführen (z.B. Host-Cron um 02:55, VOR AI_CRON 03:00):
#   55 2 * * *  cd /opt/Idlevolution && ./scripts/backup.sh >> data/backups/backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."

# POSTGRES_USER/DB gezielt aus .env lesen (kein Sourcen — Werte mit Leerzeichen)
envval() { grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'; }
PGUSER="$(envval POSTGRES_USER)"; PGUSER="${PGUSER:-idle}"
PGDB="$(envval POSTGRES_DB)"; PGDB="${PGDB:-idlevolution}"
KEEP="${BACKUP_KEEP:-14}"

TS="$(date +%Y%m%d-%H%M%S)"
DIR="data/backups/$TS"
mkdir -p "$DIR"

echo "[backup] Postgres → $DIR/db.sql.gz"
docker compose exec -T db pg_dump -U "$PGUSER" "$PGDB" | gzip > "$DIR/db.sql.gz"

echo "[backup] Inhalte → $DIR/content.tar.gz"
tar -czf "$DIR/content.tar.gz" -C data content

# Rotation: nur die letzten $KEEP Backups behalten
mapfile -t old < <(ls -1dt data/backups/*/ 2>/dev/null | tail -n +$((KEEP + 1)))
if [ "${#old[@]}" -gt 0 ]; then
  echo "[backup] entferne ${#old[@]} alte Backups"
  rm -rf "${old[@]}"
fi
echo "[backup] fertig: $DIR"
