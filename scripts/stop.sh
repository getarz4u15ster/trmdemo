#!/usr/bin/env bash
# Stop the demo stack. Data is preserved in the Postgres volume.
# Pass --reset (or -r) to also delete the volume for a clean slate.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ "${1:-}" == "--reset" || "${1:-}" == "-r" ]]; then
  echo "🧹  Stopping stack and removing volumes (fresh seed data next start)…"
  docker compose down -v
  echo "✅  Stopped and reset."
else
  echo "🛑  Stopping stack (inventory data preserved)…"
  docker compose down
  echo "✅  Stopped. Run ./scripts/stop.sh --reset to also wipe the database."
fi
