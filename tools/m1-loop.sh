#!/usr/bin/env bash
# m1-loop.sh — the M1 exit criterion, as a script.
#
# Proves the full loop against a running Worker:
#   tokens -> publish -> GET /api/data -> GET /api/health -> POST /api/event
#   -> GET /api/admin/events (event present) -> ack -> events (event gone)
# plus the refusals: bad token, bad secret, wrong role, bad shape — and all nine
# write actions, the six schema-3 ones included.
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
expect "publish mock snapshot -> 200"     200 "b.ok===true && b.units===39 && b.schema_version===3" \
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
  -d '{"action":"reserve","serial":"900107","payload":{"customer":"Acme","start":"2026-09-08","end":"2026-09-08"}}'
expect "sales cannot set readiness -> 403" 403 "" -X POST "$WORKER/api/event" -H "$(auth $T_SALES)" -H "Content-Type: application/json" \
  -d '{"action":"readiness","serial":"900107","payload":{"readiness":"DOWN"}}'
expect "unknown action -> 400"            400 "" -X POST "$WORKER/api/event" -H "$(auth $T_OWNER)" -H "Content-Type: application/json" \
  -d '{"action":"sell","serial":"900107","payload":{}}'
expect "bad serial shape -> 400"          400 "" -X POST "$WORKER/api/event" -H "$(auth $T_OWNER)" -H "Content-Type: application/json" \
  -d '{"action":"release","serial":"../evt","payload":{}}'
expect "reserve without customer -> 400"  400 "" -X POST "$WORKER/api/event" -H "$(auth $T_SALES)" -H "Content-Type: application/json" \
  -d '{"action":"reserve","serial":"900107","payload":{"start":"2026-09-08","end":"2026-09-08"}}'
expect "reserve without start -> 400"     400 "" -X POST "$WORKER/api/event" -H "$(auth $T_SALES)" -H "Content-Type: application/json" \
  -d '{"action":"reserve","serial":"900107","payload":{"customer":"Acme","end":"2026-09-08"}}'
expect "reserve without end/until -> 400" 400 "" -X POST "$WORKER/api/event" -H "$(auth $T_SALES)" -H "Content-Type: application/json" \
  -d '{"action":"reserve","serial":"900107","payload":{"customer":"Acme","start":"2026-09-08"}}'
expect "reserve with bad date -> 400"     400 "" -X POST "$WORKER/api/event" -H "$(auth $T_SALES)" -H "Content-Type: application/json" \
  -d '{"action":"reserve","serial":"900107","payload":{"customer":"Acme","start":"2026-09-08","end":"9/8/26"}}'
expect "release with bad hold_id -> 400"  400 "" -X POST "$WORKER/api/event" -H "$(auth $T_SALES)" -H "Content-Type: application/json" \
  -d '{"action":"release","serial":"900107","payload":{"hold_id":"../x"}}'
expect "bad readiness value -> 400"       400 "" -X POST "$WORKER/api/event" -H "$(auth $T_SERVICE)" -H "Content-Type: application/json" \
  -d '{"action":"readiness","serial":"900107","payload":{"readiness":"BROKEN"}}'

echo "-- crew: write"
expect "sales reserves a window -> 201, server-stamped" 201 \
  "b.id && b.ts && b.actor==='Test Kevin' && b.role==='sales' && b.action==='reserve' && b.serial==='900107' && b.payload.customer==='Acme Foods' && b.payload.start==='2026-09-08' && b.payload.end==='2026-09-10' && b.payload.until===undefined" \
  -X POST "$WORKER/api/event" -H "$(auth $T_SALES)" -H "Content-Type: application/json" \
  -d '{"action":"reserve","serial":"900107","payload":{"customer":"  Acme Foods ","purpose":"quote hold","start":"2026-09-08","end":"2026-09-10","actor":"FORGED"}}'
EV1=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")
expect "legacy until accepted as end -> 201" 201 "b.payload.start==='2026-09-08' && b.payload.end==='2026-09-08'" \
  -X POST "$WORKER/api/event" -H "$(auth $T_OWNER)" -H "Content-Type: application/json" \
  -d '{"action":"reserve","serial":"900107","payload":{"customer":"Acme","start":"2026-09-08","until":"2026-09-08"}}'
EV_LEGACY=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")
expect "release with hold_id -> 201, passed through" 201 "b.action==='release' && b.payload.hold_id==='h2812b2'" \
  -X POST "$WORKER/api/event" -H "$(auth $T_SALES)" -H "Content-Type: application/json" \
  -d '{"action":"release","serial":"900107","payload":{"hold_id":"h2812b2"}}'
EV_REL=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")
expect "service flags a pick-up -> 201 (D32)" 201 "b.payload.readiness==='NEEDS-PICKUP' && b.payload.note==='Customer called'" \
  -X POST "$WORKER/api/event" -H "$(auth $T_SERVICE)" -H "Content-Type: application/json" \
  -d '{"action":"readiness","serial":"900121","payload":{"readiness":"NEEDS-PICKUP","note":"Customer called"}}'
EV_PU=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")
expect "service sets readiness -> 201"    201 "b.role==='service' && b.payload.readiness==='NEEDS-PREP'" \
  -X POST "$WORKER/api/event" -H "$(auth $T_SERVICE)" -H "Content-Type: application/json" \
  -d '{"action":"readiness","serial":"900114","payload":{"readiness":"NEEDS-PREP","note":"blades"}}'
EV2=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")

echo "-- both events visible to crew + admin"
expect "data: pending includes both"      200 \
  "b.pending.some(e=>e.id==='$EV1') && b.pending.some(e=>e.id==='$EV2')" \
  "$WORKER/api/data" -H "$(auth $T_OWNER)"
expect "health: pending_count grew by 5"  200 "b.pending_count===$BEFORE+5" "$WORKER/api/health" -H "$(auth $T_OWNER)"
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
expect "ack the three extra events -> deleted 3" 200 "b.deleted===3" -X POST "$WORKER/api/admin/events/ack" "${H_ADMIN[@]}" -d "{\"ids\":[\"$EV_LEGACY\",\"$EV_REL\",\"$EV_PU\"]}"
expect "pending back to baseline"         200 "b.pending_count===$BEFORE" "$WORKER/api/health" -H "$(auth $T_OWNER)"

echo "-- crew: schema 3 (service + dispatch) refusals"
expect "sales cannot cancel a run -> 403"  403 "" -X POST "$WORKER/api/event" -H "$(auth $T_SALES)" -H "Content-Type: application/json" \
  -d '{"action":"dispatch_cancel","payload":{"dispatch_id":"m-a1b2c3"}}'
expect "sales cannot move a stage -> 403"  403 "" -X POST "$WORKER/api/event" -H "$(auth $T_SALES)" -H "Content-Type: application/json" \
  -d '{"action":"ticket_update","payload":{"ticket":"S1001","stage":"INSPECTION"}}'
expect "ticket_open bad priority -> 400"   400 "" -X POST "$WORKER/api/event" -H "$(auth $T_SERVICE)" -H "Content-Type: application/json" \
  -d '{"action":"ticket_open","payload":{"machine_owner":"CUSTOMER","customer":"Acme","issue":"dead","priority":"URGENT","location":"IN-SHOP","intake_move":"NONE","return_move":"NONE"}}'
expect "ticket_open bad machine_owner -> 400" 400 "" -X POST "$WORKER/api/event" -H "$(auth $T_SERVICE)" -H "Content-Type: application/json" \
  -d '{"action":"ticket_open","payload":{"machine_owner":"THEIRS","customer":"Acme","issue":"dead","priority":"LOW","location":"IN-SHOP","intake_move":"NONE","return_move":"NONE"}}'
expect "ticket_update with nothing to change -> 400" 400 "" -X POST "$WORKER/api/event" -H "$(auth $T_SERVICE)" -H "Content-Type: application/json" \
  -d '{"action":"ticket_update","payload":{"ticket":"S1001"}}'
expect "ticket_update bad ticket id -> 400" 400 "" -X POST "$WORKER/api/event" -H "$(auth $T_SERVICE)" -H "Content-Type: application/json" \
  -d '{"action":"ticket_update","payload":{"ticket":"../evt","note":"x"}}'
expect "dispatch_add bad kind -> 400"      400 "" -X POST "$WORKER/api/event" -H "$(auth $T_SALES)" -H "Content-Type: application/json" \
  -d '{"action":"dispatch_add","payload":{"kind":"HAUL","what":"x"}}'
expect "dispatch_claim bad rig -> 400"     400 "" -X POST "$WORKER/api/event" -H "$(auth $T_SERVICE)" -H "Content-Type: application/json" \
  -d '{"action":"dispatch_claim","payload":{"dispatch_id":"m-a1b2c3","rig":"THE-BIG-ONE","date":"2026-09-11","driver":"Josh"}}'
expect "dispatch_claim unknown driver -> 400" 400 "" -X POST "$WORKER/api/event" -H "$(auth $T_SERVICE)" -H "Content-Type: application/json" \
  -d '{"action":"dispatch_claim","payload":{"dispatch_id":"m-a1b2c3","rig":"TRAILER-6000","date":"2026-09-11","driver":"Steve"}}'
expect "dispatch_claim without a date -> 400" 400 "" -X POST "$WORKER/api/event" -H "$(auth $T_SERVICE)" -H "Content-Type: application/json" \
  -d '{"action":"dispatch_claim","payload":{"dispatch_id":"m-a1b2c3","rig":"TRAILER-6000","driver":"Josh"}}'
expect "dispatch_done without an id -> 400" 400 "" -X POST "$WORKER/api/event" -H "$(auth $T_SALES)" -H "Content-Type: application/json" \
  -d '{"action":"dispatch_done","payload":{"note":"done"}}'

echo "-- crew: schema 3 writes (serial optional on all six)"
expect "ticket_open with no serial -> 201, serial null" 201 \
  "b.action==='ticket_open' && b.serial===null && b.actor==='Test Josh' && b.payload.machine_owner==='CUSTOMER' && b.payload.customer==='Acme Foods' && b.payload.intake_move==='PICKUP'" \
  -X POST "$WORKER/api/event" -H "$(auth $T_SERVICE)" -H "Content-Type: application/json" \
  -d '{"action":"ticket_open","payload":{"machine_owner":"CUSTOMER","serial":null,"equipment":"Nordvale SC-2400","customer":" Acme Foods ","issue":"No power at the key switch","priority":"HIGH","site":"Watertown WI","location":"AT-CUSTOMER","intake_move":"PICKUP","return_move":"DELIVER"}}'
S3A=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")
expect "ticket_open on a fleet unit carries the serial -> 201" 201 \
  "b.serial==='900191' && b.payload.machine_owner==='WSS' && b.payload.serial==='900191'" \
  -X POST "$WORKER/api/event" -H "$(auth $T_SERVICE)" -H "Content-Type: application/json" \
  -d '{"action":"ticket_open","serial":"900191","payload":{"machine_owner":"WSS","serial":"900191","equipment":"Ironline T-500","customer":"WSS","issue":"traction motor","priority":"MEDIUM","location":"IN-SHOP","intake_move":"NONE","return_move":"NONE"}}'
S3B=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")
expect "sales may add a note (any role) -> 201, only that key travels" 201 \
  "b.payload.ticket==='S1001' && b.payload.note==='Called, no answer' && b.payload.stage===undefined" \
  -X POST "$WORKER/api/event" -H "$(auth $T_SALES)" -H "Content-Type: application/json" \
  -d '{"action":"ticket_update","payload":{"ticket":"S1001","note":"Called, no answer"}}'
S3C=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")
expect "service moves the stage -> 201" 201 \
  "b.payload.stage==='INSPECTION' && b.payload.assigned==='Zac' && b.payload.scheduled==='2026-09-11'" \
  -X POST "$WORKER/api/event" -H "$(auth $T_SERVICE)" -H "Content-Type: application/json" \
  -d '{"action":"ticket_update","payload":{"ticket":"S1002","stage":"INSPECTION","assigned":"Zac","scheduled":"2026-09-11"}}'
S3D=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")
expect "anyone adds a run -> 201" 201 \
  "b.action==='dispatch_add' && b.payload.kind==='DELIVER' && b.payload.serial==='900107' && b.payload.ticket===null && b.payload.date==='2026-09-11'" \
  -X POST "$WORKER/api/event" -H "$(auth $T_SALES)" -H "Content-Type: application/json" \
  -d '{"action":"dispatch_add","serial":"900107","payload":{"kind":"DELIVER","serial":"900107","ticket":null,"what":"Demo unit out","customer":"Quarry Road Aggregates","address":"Beloit WI","date":"2026-09-11","note":null}}'
S3E=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")
expect "anyone claims a run -> 201" 201 \
  "b.payload.dispatch_id==='m-a1b2c3' && b.payload.rig==='TRAILER-6000' && b.payload.driver==='Josh'" \
  -X POST "$WORKER/api/event" -H "$(auth $T_SERVICE)" -H "Content-Type: application/json" \
  -d '{"action":"dispatch_claim","payload":{"dispatch_id":"m-a1b2c3","rig":"TRAILER-6000","date":"2026-09-11","driver":"Josh"}}'
S3F=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")
expect "anyone marks it done -> 201" 201 "b.action==='dispatch_done' && b.payload.note==='On the dock'" \
  -X POST "$WORKER/api/event" -H "$(auth $T_SALES)" -H "Content-Type: application/json" \
  -d '{"action":"dispatch_done","payload":{"dispatch_id":"m-a1b2c3","note":"On the dock"}}'
S3G=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")
expect "owner cancels a manual run -> 201" 201 "b.action==='dispatch_cancel' && b.role==='owner'" \
  -X POST "$WORKER/api/event" -H "$(auth $T_OWNER)" -H "Content-Type: application/json" \
  -d '{"action":"dispatch_cancel","payload":{"dispatch_id":"m-a1b2c3"}}'
S3H=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")

expect "all eight schema-3 events drained -> deleted 8" 200 "b.deleted===8" \
  -X POST "$WORKER/api/admin/events/ack" "${H_ADMIN[@]}" \
  -d "{\"ids\":[\"$S3A\",\"$S3B\",\"$S3C\",\"$S3D\",\"$S3E\",\"$S3F\",\"$S3G\",\"$S3H\"]}"
expect "pending back to baseline again"    200 "b.pending_count===$BEFORE" "$WORKER/api/health" -H "$(auth $T_OWNER)"

echo "-- misc"
expect "unknown route -> 404"             404 "" "$WORKER/api/nope" -H "$(auth $T_OWNER)"
expect "wrong method -> 405"              405 "" -X POST "$WORKER/api/data" -H "$(auth $T_OWNER)"
expect "CORS preflight from Pages origin -> 204" 204 "" -X OPTIONS "$WORKER/api/data" \
  -H "Origin: https://mlancourt.github.io" -H "Access-Control-Request-Method: GET"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
