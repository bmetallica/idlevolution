#!/usr/bin/env bash
# Löst die KI-Content-Generierung manuell aus (statt auf den Cron zu warten).
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose exec ai-worker node src/ai/run-nightly.js
