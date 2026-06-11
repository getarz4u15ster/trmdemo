#!/usr/bin/env bash
# Full reset: tear down (incl. volume), rebuild, and start fresh seed data.
# Handy right before a live demo so inventory counts are pristine.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "🔄  Resetting demo to a clean state…"
docker compose down -v
exec ./scripts/start.sh
