#!/usr/bin/env bash
# Build (if needed) and start the full demo stack, then wait for health.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "🚀  Starting ABC Supermarkets × InventorySoft demo stack…"
docker compose up --build -d

echo "⏳  Waiting for the InventorySoft API to become healthy…"
for i in $(seq 1 30); do
  if curl -fs http://localhost:3001/health >/dev/null 2>&1; then
    echo "✅  Stack is up!"
    echo
    echo "   Storefront    → http://localhost:3000"
    echo "   API           → http://localhost:3001"
    echo "   Swagger UI     → http://localhost:3001/docs"
    echo "   Health         → http://localhost:3001/health"
    echo
    echo "   Logs:  ./scripts/logs.sh      Stop:  ./scripts/stop.sh"
    exit 0
  fi
  sleep 1
done

echo "❌  API did not become healthy in time. Recent logs:"
docker compose logs api --tail 30
exit 1
