#!/usr/bin/env bash
# Tail logs for the whole stack, or a single service: ./scripts/logs.sh api
set -euo pipefail

cd "$(dirname "$0")/.."

docker compose logs -f --tail 100 "$@"
