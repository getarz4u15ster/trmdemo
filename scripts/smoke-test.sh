#!/usr/bin/env bash
# End-to-end smoke test of the InventorySoft API contract + storefront proxy.
# Assumes the stack is already running (./scripts/start.sh).
set -uo pipefail

API="${API:-http://localhost:3001}"
STORE="${STORE:-http://localhost:3000}"
pass=0; fail=0

check () { # check "label" expected actual
  if [[ "$2" == "$3" ]]; then echo "  ✅  $1"; pass=$((pass+1));
  else echo "  ❌  $1 (expected $2, got $3)"; fail=$((fail+1)); fi
}

code () { curl -s -o /dev/null -w "%{http_code}" "$@"; }

echo "🧪  Smoke testing $API"

echo "• Health & docs"
check "GET /health 200"          200 "$(code "$API/health")"
check "GET /docs 200"            200 "$(code "$API/docs/")"

echo "• Reads"
check "GET /item/92746661 200"   200 "$(code "$API/item/92746661")"
check "GET /item/000 404"        404 "$(code "$API/item/000")"
check "GET /organization/351"    200 "$(code "$API/organization/351")"
check "GET /organization/999"    404 "$(code "$API/organization/999")"

echo "• Admin (sync)"
check "POST /admin INCREASE 200" 200 "$(code -X POST "$API/admin/92746661" -H 'Content-Type: application/json' -d '{"operatorDirection":"INCREASE","operatorMagnitude":10,"organizationId":"351"}')"
check "POST /admin overdraw 409" 409 "$(code -X POST "$API/admin/92746661" -H 'Content-Type: application/json' -d '{"operatorDirection":"DECREASE","operatorMagnitude":999999,"organizationId":"351"}')"
check "POST /admin bad body 400" 400 "$(code -X POST "$API/admin/92746661" -H 'Content-Type: application/json' -d '{"operatorDirection":"SIDEWAYS","operatorMagnitude":1,"organizationId":"351"}')"

echo "• Async sale + poll"
EVT=$(curl -s -X POST "$API/item/92746661" -H 'Content-Type: application/json' -d '{"organizationId":"351"}')
EID=$(echo "$EVT" | sed -E 's/.*"eventId":"([^"]+)".*/\1/')
check "POST /item returns eventId" "yes" "$([[ -n "$EID" ]] && echo yes || echo no)"
sleep 2
STATUS=$(curl -s "$API/events/$EID" | sed -E 's/.*"status":"([^"]+)".*/\1/')
check "event COMPLETED"           "COMPLETED" "$STATUS"

echo "• Idempotency"
K="smoke-$RANDOM"
E1=$(curl -s -X POST "$API/item/92746663" -H 'Content-Type: application/json' -H "Idempotency-Key: $K" -d '{"organizationId":"351"}' | sed -E 's/.*"eventId":"([^"]+)".*/\1/')
E2=$(curl -s -X POST "$API/item/92746663" -H 'Content-Type: application/json' -H "Idempotency-Key: $K" -d '{"organizationId":"351"}' | sed -E 's/.*"eventId":"([^"]+)".*/\1/')
check "retry returns same eventId" "$E1" "$E2"

echo "• Analytics"
check "GET timeseries 200"        200 "$(code "$API/analytics/organization/351/timeseries")"
check "timeseries has soldByItem" "yes" "$(curl -s "$API/analytics/organization/351/timeseries" | grep -q soldByItem && echo yes || echo no)"

echo "• Risk monitoring"
check "GET /alerts 200"           200 "$(code "$API/alerts?organizationId=351")"
check "alerts has summary"        "yes" "$(curl -s "$API/alerts?organizationId=351" | grep -q '"summary"' && echo yes || echo no)"

echo "• Storefront proxy"
check "GET / 200"                 200 "$(code "$STORE/")"
check "GET /limiter-stats 200"    200 "$(code "$STORE/limiter-stats")"
check "proxy GET org 200"         200 "$(code "$STORE/proxy/organization/351")"

echo
echo "──────────────────────────────"
echo "  Passed: $pass   Failed: $fail"
[[ $fail -eq 0 ]] && echo "  🎉  All checks passed." || echo "  ⚠  Some checks failed."
exit $fail
