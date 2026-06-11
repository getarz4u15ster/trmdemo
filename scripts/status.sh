#!/usr/bin/env bash
# Show container status + a quick health probe of each service.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "📦  Containers:"
docker compose ps

probe () {
  local name="$1" url="$2"
  if curl -fs -o /dev/null "$url" 2>/dev/null; then
    echo "   ✅  $name ($url)"
  else
    echo "   ❌  $name ($url) — not responding"
  fi
}

echo
echo "🔎  Endpoint health:"
probe "API health"   "http://localhost:3001/health"
probe "Swagger UI"   "http://localhost:3001/docs/"
probe "Storefront"   "http://localhost:3000/"
probe "Limiter stats" "http://localhost:3000/limiter-stats"
