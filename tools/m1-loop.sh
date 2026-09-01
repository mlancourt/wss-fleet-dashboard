#!/usr/bin/env bash
# m1-loop.sh — the M1 exit criterion, as a script.
#
# Proves the full loop against a running Worker:
#   tokens -> publish -> GET /api/data -> GET /api/health -> POST /api/event
#   -> GET /api/admin/events (event present) -> ack -> events (event gone)
# plus the refusals: bad token, bad secret, wrong role, bad shape.
#
# Local:   npm run dev:worker     (in another terminal)      then:  npm run m1
# Remote:  WORKER=https://wss-fleet-worker.<you>.workers.dev ADMIN_SECRET=... npm run m1
#          (remote runs use a throwaway token map — re-post the real one after)
#
# Requires curl + node. No other dependencies. All data here is FAKE.
set -euo pipefail

WORKER="${WORKER:-http://localhost:8788}"
ADMIN_SECRET="${ADMIN_SECRET:-dev-admin-secret-not-for-production}"
SNAPSHOT="${SNAPSHOT:-$(dirname "$0")/../docs/mock/mock-full.json}"

# Throwaway crew tokens for the test. Shape matches `openssl rand -hex 16`.
T_SALES="m1testsales00000000000000000001"
T_SERVICE="m1testservice000000000000000001"
T_OWNER="m1testowner00000000000000000001"

pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  ok   %s\n' "$1"; }
bad()  { fail=$((fail+1)); printf '  FAIL %s\n       %s\n' "$1" "$2"; }

# expect <label> <status-wanted> <node-expr-on-$body or ''> <curl args...>
expect() {
  local label="$1" want="$2" check="$3"; shift 3
  local out status body
  out=$(curl -sS -o /tmp/m1body.$$ -w '%{http_code}' "$@") || { bad "$label" "curl failed"; return; }
  status="$out"; body=$(cat /tmp/m1body.$$); rm -f /tmp/m1body.$$
  if [ "$status" != "$want" ]; then bad "$label" "status $status, wanted $want: ${body:0:200}"; return; fi
  if [ -n "$check" ]; then
    if ! node -e "const b=JSON.parse(process.argv[1]); if(!($check)) process.exit(1)" "$body" 2>/dev/null; then
      bad "$label" "check failed [$check]: ${body:0:200}"; return
    fi
  fi
  ok "$label"
  LAST="$body"
}

H_ADMIN=(-H "X-Admin-Secret: $ADMIN_SECRET" -H "Content-Type: application/json")
auth() { echo "Authorization: Bearer $1"; }

echo "M1 loop against $WORKER"
echo

echo "-- admin: refusals"
expect "publish without secret -> 401"     401 "b.error==='unauthorized'" -X POST "$WORKER/api/admin/publish" -d '{}'
expect "publish with wrong secret -> 401"  401 "" -X POST "$WORKER/api/admin/publish" -H "X-Admin-Secret: nope" -d '{}'
expect "publish garbage -> 400"            400 "" -X POST "$WORKER/api/admin/publish" "${H_ADMIN[@]}" -d 'not json'
expect "publish without schema_version -> 400" 400 "" -X POST "$WORKER/api/admin/publish" "${H_ADMIN[@]}" -d '{"meta":{}}'
expect "tokens: empty map refused -> 400"  400 "" -X POST "$WORKER/api/admin/tokens" "${H_ADMIN[@]}" -d '{}'
expect "tokens: bad role refused -> 400"   400 "" -X POST "$WORKER/api/admin/tokens" "${H_ADMIN[@]}" \
  -d "{\"$T_SALES\":{\"name\":\"X\",\"role\":\"admin\"}}"

echo "-- admin: load tokens + publish"
expect "tokens: 3-person map -> 200 (names only echoed)" 200 \
  "b.ok===true && b.count===3 && JSON.stringify(b).indexOf('m1test')===-1" \
  -X POST "$WORKER/api/admin/tokens" "${H_ADMIN[@]}" \
  -d "{\"$T_SALES\":{\"name\":\"Test Kevin\",\"role\":\"sales\"},
       \"$T_SERVICE\":{\"name\":\"Test Josh\",\"role\":\"service\"},
       \"$T_OWNER\":{\"name\":\"Test Matt\",\"role\":\"owner\"}}"
expect "publish mock snapshot -> 200"     200 "b.ok===true && b.units===39 && b.schema_version===1" \
  -X POST "$WORKER/api/admin/publish" "${H_ADMIN[@]}" --data-binary "@$SNAPSHOT"

echo "-- crew: read"
expect "data without token -> 401"        401 "" "$WORKER/api/data"
expect "data with unknown token -> 401"   401 "" "$WORKER/api/data" -H "$(auth unknowntoken0000000000000000000)"
expect "data as sales -> 200, me.role from server" 200 \
  "b.me.role==='sales' && b.me.name==='Test Kevin' && b.snapshot.units.length===39 && Array.isArray(b.pending)" \
  "$WORKER/api/data" -H "$(auth $T_SALES)"
expect "data via ?t= also works"          200 "b.me.role==='service'" "$WORKER/api/data?t=$T_SERVICE"
expect "health -> 200"                    200 "typeof b.pending_count==='number' && b.published_at" \
  "$WORKER/api/health" -H "$(auth $T_SALES)"
BEFORE=$(node -e "console.log(JSON.parse(process.argv[1]).pending_count)" "$LAST")

echo "-- crew: write refusals"
expect "service cannot reserve -> 403"    403 "" -X POST "$WORKER/api/event" -H "$(auth $T_SERVICE)" -H "Content-Type: application/json" \
  -d '{"action":"reserve","serial":"900107","payload":{"customer":"Acme","until":"2026-09-08"}}'
expect "sales cannot set readiness -> 403" 403 "" -X POST "$WORKER/api/event" -H "$(auth $T_SALES)" -H "Content-Type: application/json" \
  -d '{"action":"readiness","serial":"900107","payload":{"readiness":"DOWN"}}'
expect "unknown action -> 400"            400 "" -X POST "$WORKER/api/event" -H "$(auth $T_OWNER)" -H "Content-Type: application/json" \
  -d '{"action":"sell","serial":"900107","payload":{}}'
expect "bad serial shape -> 400"          400 "" -X POST "$WORKER/api/event" -H "$(auth $T_OWNER)" -H "Content-Type: application/json" \
  -d '{"action":"release","serial":"../evt","payload":{}}'
expect "reserve without customer -> 400"  400 "" -X POST "$WORKER/api/event" -H "$(auth $T_SALES)" -H "Content-Type: application/json" \
  -d '{"action":"reserve","serial":"900107","payload":{"until":"2026-09-08"}}'
expect "reserve with bad date -> 400"     400 "" -X POST "$WORKER/api/event" -H "$(auth $T_SALES)" -H "Content-Type: application/json" \
  -d '{"action":"reserve","serial":"900107","payload":{"customer":"Acme","until":"9/8/26"}}'
expect "bad readiness value -> 400"       400 "" -X POST "$WORKER/api/event" -H "$(auth $T_SERVICE)" -H "Content-Type: application/json" \
  -d '{"action":"readiness","serial":"900107","payload":{"readiness":"BROKEN"}}'

echo "-- crew: write"
expect "sales reserves -> 201, server-stamped" 201 \
  "b.id && b.ts && b.actor==='Test Kevin' && b.role==='sales' && b.action==='reserve' && b.serial==='900107' && b.payload.customer==='Acme Foods'" \
  -X POST "$WORKER/api/event" -H "$(auth $T_SALES)" -H "Content-Type: application/json" \
  -d '{"action":"reserve","serial":"900107","payload":{"customer":"  Acme Foods ","purpose":"quote hold","until":"2026-09-08","actor":"FORGED"}}'
EV1=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")
expect "service sets readiness -> 201"    201 "b.role==='service' && b.payload.readiness==='NEEDS-PREP'" \
  -X POST "$WORKER/api/event" -H "$(auth $T_SERVICE)" -H "Content-Type: application/json" \
  -d '{"action":"readiness","serial":"900114","payload":{"readiness":"NEEDS-PREP","note":"blades"}}'
EV2=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")

echo "-- both events visible to crew + admin"
expect "data: pending includes both"      200 \
  "b.pending.some(e=>e.id==='$EV1') && b.pending.some(e=>e.id==='$EV2')" \
  "$WORKER/api/data" -H "$(auth $T_OWNER)"
expect "health: pending_count grew by 2"  200 "b.pending_count===$BEFORE+2" "$WORKER/api/health" -H "$(auth $T_OWNER)"
expect "admin events lists both, oldest first" 200 \
  "b.events.some(e=>e.id==='$EV1' && e.key==='evt:$EV1') && b.events.some(e=>e.id==='$EV2') && b.events.findIndex(e=>e.id==='$EV1') < b.events.findIndex(e=>e.id==='$EV2')" \
  "$WORKER/api/admin/events" -H "X-Admin-Secret: $ADMIN_SECRET"

echo "-- ack only what we name"
expect "ack empty -> 400"                 400 "" -X POST "$WORKER/api/admin/events/ack" "${H_ADMIN[@]}" -d '{"ids":[]}'
expect "ack non-evt key refused -> 400"   400 "" -X POST "$WORKER/api/admin/events/ack" "${H_ADMIN[@]}" -d '{"ids":["evt:"]}'
expect "ack EV1 -> deleted 1"             200 "b.deleted===1" -X POST "$WORKER/api/admin/events/ack" "${H_ADMIN[@]}" -d "{\"ids\":[\"$EV1\"]}"
expect "EV1 gone, EV2 survives"           200 \
  "!b.events.some(e=>e.id==='$EV1') && b.events.some(e=>e.id==='$EV2')" \
  "$WORKER/api/admin/events" -H "X-Admin-Secret: $ADMIN_SECRET"
expect "ack EV2 by full key -> deleted 1" 200 "b.deleted===1" -X POST "$WORKER/api/admin/events/ack" "${H_ADMIN[@]}" -d "{\"ids\":[\"evt:$EV2\"]}"
expect "pending back to baseline"         200 "b.pending_count===$BEFORE" "$WORKER/api/health" -H "$(auth $T_OWNER)"

echo "-- misc"
expect "unknown route -> 404"             404 "" "$WORKER/api/nope" -H "$(auth $T_OWNER)"
expect "wrong method -> 405"              405 "" -X POST "$WORKER/api/data" -H "$(auth $T_OWNER)"
expect "CORS preflight from Pages origin -> 204" 204 "" -X OPTIONS "$WORKER/api/data" \
  -H "Origin: https://mlancourt.github.io" -H "Access-Control-Request-Method: GET"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
