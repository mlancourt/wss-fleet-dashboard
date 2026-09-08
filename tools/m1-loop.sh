#!/usr/bin/env bash
# m1-loop.sh — the M1 exit criterion, as a script.
#
# Proves the full loop against a running Worker:
#   tokens -> publish -> GET /api/data -> GET /api/health -> POST /api/event
#   -> GET /api/admin/events (event present) -> ack -> events (event gone)
#   -> DELETE /api/event/<id> (undo your own, and only your own)
#   -> PUT/GET/DELETE a document (schema 6) with the hash check that names it
#   -> POST a document from a "phone" + the doc_attach event that points at it (S2)
# plus the refusals: bad token, bad secret, wrong role, bad shape — and all
# thirteen write actions: the six schema-3 (D47's NEEDS-QUOTE stage included),
# three schema-5 ones, doc_attach (schema 6 / S2), and the
# schema-5 MONEY GATE: a service token's /api/data must not carry lead money.
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

# expecth <label> <status-wanted> <grep-pattern-on-headers|''> <curl args...>
# Same as expect(), but asserts on the RESPONSE HEADERS. Documents are bytes:
# the Content-Type and the inline disposition are the contract, not the body.
expecth() {
  local label="$1" want="$2" pattern="$3"; shift 3
  local hdrs status
  hdrs=$(curl -sS -D - -o /dev/null "$@") || { bad "$label" "curl failed"; return; }
  status=$(printf '%s' "$hdrs" | awk 'NR==1{print $2}')
  if [ "$status" != "$want" ]; then bad "$label" "status $status, wanted $want"; return; fi
  if [ -n "$pattern" ] && ! printf '%s' "$hdrs" | grep -qi "$pattern"; then
    bad "$label" "header not found [$pattern]"; return
  fi
  ok "$label"
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
expect "publish mock snapshot -> 200"     200 "b.ok===true && b.units===39 && b.schema_version===6" \
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
  -d '{"action":"ticket_update","payload":{"ticket":"S1001","stage":"CONTACTED"}}'
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
  "b.payload.stage==='CONTACTED' && b.payload.assigned==='Zac' && b.payload.scheduled==='2026-09-11'" \
  -X POST "$WORKER/api/event" -H "$(auth $T_SERVICE)" -H "Content-Type: application/json" \
  -d '{"action":"ticket_update","payload":{"ticket":"S1002","stage":"CONTACTED","assigned":"Zac","scheduled":"2026-09-11"}}'
S3D=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")
expect "service moves a customer ticket to NEEDS-QUOTE -> 201 (D47)" 201 \
  "b.payload.ticket==='S1011' && b.payload.stage==='NEEDS-QUOTE' && b.payload.note==='Priced the pair, Matt owes them a number'" \
  -X POST "$WORKER/api/event" -H "$(auth $T_SERVICE)" -H "Content-Type: application/json" \
  -d '{"action":"ticket_update","payload":{"ticket":"S1011","stage":"NEEDS-QUOTE","note":"Priced the pair, Matt owes them a number"}}'
S3I=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")
expect "owner may too -> 201" 201 "b.payload.stage==='NEEDS-QUOTE' && b.role==='owner'" \
  -X POST "$WORKER/api/event" -H "$(auth $T_OWNER)" -H "Content-Type: application/json" \
  -d '{"action":"ticket_update","payload":{"ticket":"S1012","stage":"NEEDS-QUOTE"}}'
S3J=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")
expect "sales still cannot -> 403" 403 "" -X POST "$WORKER/api/event" -H "$(auth $T_SALES)" -H "Content-Type: application/json" \
  -d '{"action":"ticket_update","payload":{"ticket":"S1011","stage":"NEEDS-QUOTE"}}'
# The Worker validates membership, not business state: a NEEDS-QUOTE on one of
# OUR machines is accepted here and refused by the vault ("nobody quotes us to
# us"). The site never offers the button; this proves where the line is drawn.
expect "NEEDS-QUOTE on a WSS ticket passes the Worker — the vault referees" 201 \
  "b.payload.ticket==='S1002' && b.payload.stage==='NEEDS-QUOTE'" \
  -X POST "$WORKER/api/event" -H "$(auth $T_SERVICE)" -H "Content-Type: application/json" \
  -d '{"action":"ticket_update","payload":{"ticket":"S1002","stage":"NEEDS-QUOTE"}}'
S3K=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")
expect "a stage we have never heard of -> 400" 400 "" -X POST "$WORKER/api/event" -H "$(auth $T_SERVICE)" -H "Content-Type: application/json" \
  -d '{"action":"ticket_update","payload":{"ticket":"S1011","stage":"NEEDS-COFFEE"}}'

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

expect "all eleven schema-3 events drained -> deleted 11" 200 "b.deleted===11" \
  -X POST "$WORKER/api/admin/events/ack" "${H_ADMIN[@]}" \
  -d "{\"ids\":[\"$S3A\",\"$S3B\",\"$S3C\",\"$S3D\",\"$S3E\",\"$S3F\",\"$S3G\",\"$S3H\",\"$S3I\",\"$S3J\",\"$S3K\"]}"
expect "pending back to baseline again"    200 "b.pending_count===$BEFORE" "$WORKER/api/health" -H "$(auth $T_OWNER)"

echo "-- crew: undo a pending event (D46)"
# Kevin taps something, then thinks better of it.
expect "sales posts an event to undo -> 201" 201 "b.actor==='Test Kevin'" \
  -X POST "$WORKER/api/event" -H "$(auth $T_SALES)" -H "Content-Type: application/json" \
  -d '{"action":"reserve","serial":"900107","payload":{"customer":"Mistake Co","start":"2026-09-08","end":"2026-09-08"}}'
UNDO_ID=$(node -e "console.log(encodeURIComponent(JSON.parse(process.argv[1]).id))" "$LAST")
RAW_ID=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")

expect "undo without a token -> 401"       401 "" -X DELETE "$WORKER/api/event/$UNDO_ID"
expect "undo with an unknown token -> 401" 401 "" -X DELETE "$WORKER/api/event/$UNDO_ID" \
  -H "$(auth unknowntoken0000000000000000000)"
expect "someone else's event -> 403"       403 "" -X DELETE "$WORKER/api/event/$UNDO_ID" -H "$(auth $T_SERVICE)"
expect "owner gets NO override -> 403"     403 "" -X DELETE "$WORKER/api/event/$UNDO_ID" -H "$(auth $T_OWNER)"
expect "still there after the refusals"    200 "b.events.some(e=>e.id==='$RAW_ID')" \
  "$WORKER/api/admin/events" -H "X-Admin-Secret: $ADMIN_SECRET"

expect "own event -> 200 {ok,id}"          200 "b.ok===true && b.id==='$RAW_ID'" \
  -X DELETE "$WORKER/api/event/$UNDO_ID" -H "$(auth $T_SALES)"
expect "and it is gone from the inbox"     200 "!b.events.some(e=>e.id==='$RAW_ID')" \
  "$WORKER/api/admin/events" -H "X-Admin-Secret: $ADMIN_SECRET"
expect "undoing it again -> 404"           404 "" -X DELETE "$WORKER/api/event/$UNDO_ID" -H "$(auth $T_SALES)"
expect "an id that never existed -> 404"   404 "" -X DELETE "$WORKER/api/event/nope%3Anope" -H "$(auth $T_SALES)"
expect "a traversal-shaped id -> 400"      400 "" -X DELETE "$WORKER/api/event/..%2F..%2Fsnapshot" -H "$(auth $T_SALES)"
expect "the snapshot is untouched"         200 "b.snapshot.units.length===39" "$WORKER/api/data" -H "$(auth $T_OWNER)"
expect "GET on the id path -> 405"         405 "" "$WORKER/api/event/$UNDO_ID" -H "$(auth $T_SALES)"
expect "pending back to baseline after undo" 200 "b.pending_count===$BEFORE" "$WORKER/api/health" -H "$(auth $T_OWNER)"

echo "-- crew: leads (schema 5) refusals"
expect "service may not close a lead -> 403" 403 "" -X POST "$WORKER/api/event" -H "$(auth $T_SERVICE)" -H "Content-Type: application/json" \
  -d '{"action":"lead_close","payload":{"lead":"L1001","outcome":"DEAD"}}'
expect "service may not move a lead stage -> 403" 403 "" -X POST "$WORKER/api/event" -H "$(auth $T_SERVICE)" -H "Content-Type: application/json" \
  -d '{"action":"lead_update","payload":{"lead":"L1001","stage":"CONTACTED"}}'
expect "service may not set a lead value -> 403" 403 "" -X POST "$WORKER/api/event" -H "$(auth $T_SERVICE)" -H "Content-Type: application/json" \
  -d '{"action":"lead_update","payload":{"lead":"L1001","value":9000}}'
expect "lead_open bad source -> 400"       400 "" -X POST "$WORKER/api/event" -H "$(auth $T_SALES)" -H "Content-Type: application/json" \
  -d '{"action":"lead_open","payload":{"customer":"Acme","source":"CARRIER-PIGEON","interest":"RENTAL","priority":"LOW"}}'
expect "lead_open bad interest -> 400"     400 "" -X POST "$WORKER/api/event" -H "$(auth $T_SALES)" -H "Content-Type: application/json" \
  -d '{"action":"lead_open","payload":{"customer":"Acme","source":"PHONE","interest":"VIBES","priority":"LOW"}}'
expect "lead_open without a customer -> 400" 400 "" -X POST "$WORKER/api/event" -H "$(auth $T_SALES)" -H "Content-Type: application/json" \
  -d '{"action":"lead_open","payload":{"source":"PHONE","interest":"RENTAL","priority":"LOW"}}'
expect "a value as a string -> 400"        400 "" -X POST "$WORKER/api/event" -H "$(auth $T_SALES)" -H "Content-Type: application/json" \
  -d '{"action":"lead_update","payload":{"lead":"L1001","value":"14,250"}}'
expect "a negative value -> 400"           400 "" -X POST "$WORKER/api/event" -H "$(auth $T_SALES)" -H "Content-Type: application/json" \
  -d '{"action":"lead_update","payload":{"lead":"L1001","value":-5}}'
expect "lead_update with nothing to change -> 400" 400 "" -X POST "$WORKER/api/event" -H "$(auth $T_SALES)" -H "Content-Type: application/json" \
  -d '{"action":"lead_update","payload":{"lead":"L1001"}}'
expect "lead_update bad lead id -> 400"    400 "" -X POST "$WORKER/api/event" -H "$(auth $T_SALES)" -H "Content-Type: application/json" \
  -d '{"action":"lead_update","payload":{"lead":"../evt","note":"x"}}'
expect "lead_close bad outcome -> 400"     400 "" -X POST "$WORKER/api/event" -H "$(auth $T_SALES)" -H "Content-Type: application/json" \
  -d '{"action":"lead_close","payload":{"lead":"L1001","outcome":"WON"}}'
expect "lead_close bad reason -> 400"      400 "" -X POST "$WORKER/api/event" -H "$(auth $T_SALES)" -H "Content-Type: application/json" \
  -d '{"action":"lead_close","payload":{"lead":"L1001","outcome":"LOST","reason":"BAD-VIBES"}}'

echo "-- crew: leads (schema 5) writes"
expect "anyone opens a lead -> 201, server-stamped, no id yet" 201 \
  "b.action==='lead_open' && b.serial===null && b.actor==='Test Josh' && b.payload.customer==='Stonebridge Cold Storage' && b.payload.source==='PHONE' && b.payload.interest==='RENTAL' && b.payload.value===null && b.payload.assigned==='Kevin'" \
  -X POST "$WORKER/api/event" -H "$(auth $T_SERVICE)" -H "Content-Type: application/json" \
  -d '{"action":"lead_open","payload":{"customer":"  Stonebridge Cold Storage ","contact":"Nadia Kohl","phone":"262-555-0199","email":null,"site":"Pewaukee WI","source":"PHONE","interest":"RENTAL","machine":"Rider for a freezer floor","serial":null,"value":null,"priority":"HIGH","assigned":"Kevin","next_action":"Kevin to call back","note":"Called the shop line","related_ticket":null,"machinio_ref":null,"force":false}}'
L5A=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")
expect "force is Matt's alone — dropped for sales" 201 "b.payload.force===false" \
  -X POST "$WORKER/api/event" -H "$(auth $T_SALES)" -H "Content-Type: application/json" \
  -d '{"action":"lead_open","payload":{"customer":"Duplicate Co","source":"WEB-FORM","interest":"SALE-NEW","priority":"LOW","force":true}}'
L5B=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")
expect "force is honoured for owner -> 201"  201 "b.payload.force===true" \
  -X POST "$WORKER/api/event" -H "$(auth $T_OWNER)" -H "Content-Type: application/json" \
  -d '{"action":"lead_open","payload":{"customer":"Duplicate Co","source":"WEB-FORM","interest":"SALE-NEW","priority":"LOW","force":true}}'
L5C=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")
expect "sales moves a lead to DEMO-SCHEDULED -> 201" 201 \
  "b.payload.lead==='L1005' && b.payload.stage==='DEMO-SCHEDULED' && b.payload.demo_date==='2026-09-11' && b.payload.demo_serial==='900114' && b.payload.value===undefined" \
  -X POST "$WORKER/api/event" -H "$(auth $T_SALES)" -H "Content-Type: application/json" \
  -d '{"action":"lead_update","payload":{"lead":"L1005","stage":"DEMO-SCHEDULED","demo_date":"2026-09-11","demo_serial":"900114","note":"They want to see it run"}}'
L5D=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")
expect "sales sets a value -> 201, only that key travels" 201 \
  "b.payload.value===14250 && b.payload.stage===undefined && b.payload.note===undefined" \
  -X POST "$WORKER/api/event" -H "$(auth $T_SALES)" -H "Content-Type: application/json" \
  -d '{"action":"lead_update","payload":{"lead":"L1006","value":14250}}'
L5E=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")
expect "service adds a NOTE to a lead -> 201 (the one key they get)" 201 \
  "b.payload.lead==='L1003' && b.payload.note==='They called the shop line' && b.role==='service'" \
  -X POST "$WORKER/api/event" -H "$(auth $T_SERVICE)" -H "Content-Type: application/json" \
  -d '{"action":"lead_update","payload":{"lead":"L1003","note":"They called the shop line"}}'
L5F=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")
expect "sales closes a lead as LOST -> 201" 201 \
  "b.action==='lead_close' && b.payload.outcome==='LOST' && b.payload.reason==='PRICE'" \
  -X POST "$WORKER/api/event" -H "$(auth $T_SALES)" -H "Content-Type: application/json" \
  -d '{"action":"lead_close","payload":{"lead":"L1011","outcome":"LOST","reason":"PRICE","note":"Undercut on a private sale"}}'
L5G=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")
expect "a DEAD lead needs no reason -> 201" 201 "b.payload.outcome==='DEAD' && b.payload.reason===null" \
  -X POST "$WORKER/api/event" -H "$(auth $T_OWNER)" -H "Content-Type: application/json" \
  -d '{"action":"lead_close","payload":{"lead":"L1013","outcome":"DEAD","reason":null,"note":"Three calls, no answer"}}'
L5H=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")

expect "all eight lead events drained -> deleted 8" 200 "b.deleted===8" \
  -X POST "$WORKER/api/admin/events/ack" "${H_ADMIN[@]}" \
  -d "{\"ids\":[\"$L5A\",\"$L5B\",\"$L5C\",\"$L5D\",\"$L5E\",\"$L5F\",\"$L5G\",\"$L5H\"]}"
expect "pending back to baseline after the leads" 200 "b.pending_count===$BEFORE" "$WORKER/api/health" -H "$(auth $T_OWNER)"

echo "-- the money gate (Leads spec §6, L4) — NOT optional"
# The literal grep the spec names. It runs on the RAW bytes, before any JSON
# parse, because the thing being asserted is that the string is not in the
# response at all — not that some parsed field happens to be undefined.
SVC_BODY=$(curl -sS "$WORKER/api/data" -H "$(auth $T_SERVICE)")
if printf '%s' "$SVC_BODY" | grep -q 'potential_commission'; then
  bad "service token /api/data must not contain 'potential_commission'" \
      "found it — the money gate is not stripping"
else
  ok "service token /api/data does not contain 'potential_commission'"
fi
if printf '%s' "$SVC_BODY" | grep -q 'commission_rates'; then
  bad "service token /api/data must not contain 'commission_rates'" "found it"
else
  ok "service token /api/data does not contain 'commission_rates'"
fi
expect "service: no money on any lead, no scoreboard.money" 200 \
  "b.snapshot.leads.every(l=>!('value' in l) && !('potential_commission' in l)) && !('money' in b.snapshot.scoreboard) && !('commission_rates' in b.snapshot.leads_summary) && !('money_fields' in b.snapshot.leads_summary)" \
  "$WORKER/api/data" -H "$(auth $T_SERVICE)"
# v2.5: the lead log is money-free BY CONTRACT — the engine writes "value set"
# and its builder refuses to publish a row carrying a figure — so the v2.4
# fail-closed strip of leads[].log is reversed and a tech keeps their own notes.
# The assertion moved onto the TEXT, which is where the guarantee now lives.
expect "service: the lead log survives (v2.5 reversal)" 200 \
  "b.snapshot.leads.some(l=>Array.isArray(l.log) && l.log.length>0)" \
  "$WORKER/api/data" -H "$(auth $T_SERVICE)"
expect "service: no lead-log row matches /\\\$\\s?\\d/" 200 \
  "b.snapshot.leads.flatMap(l=>l.log||[]).every(r=>!/\\\$\\s?\\d/.test(r.text||''))" \
  "$WORKER/api/data" -H "$(auth $T_SERVICE)"
# NOT asserted: "no figure anywhere under leads[]". The contract cannot promise
# that and should not pretend to — `machine` and `close_note` are free text a
# person types, and the mock legitimately carries 'Used 32" rider under $18k'
# and 'Came in $2,400 under us'. Those are a customer's budget and a
# competitor's price, not our deal value or anybody's commission. The gate
# covers the structured money and the log row the ENGINE writes; a sentence
# somebody typed is theirs.
expect "service: TICKET logs survive — that is where the shop's work is" 200 \
  "b.snapshot.service_queue.some(t=>Array.isArray(t.log) && t.log.length>0)" \
  "$WORKER/api/data" -H "$(auth $T_SERVICE)"
# schema 6: docs are NEVER stripped and never role-gated. A QUOTE on a lead
# carries a customer-facing price, which the customer already has — and a tech
# who cannot open the work order for the machine on his bench has no board.
expect "service: docs[] survive the gate, on leads and on tickets" 200 \
  "b.snapshot.leads.some(l=>Array.isArray(l.docs) && l.docs.length>0) && b.snapshot.service_queue.some(t=>Array.isArray(t.docs) && t.docs.length>0)" \
  "$WORKER/api/data" -H "$(auth $T_SERVICE)"
expect "service: insights survive untouched (deal size is not commission)" 200 \
  "b.snapshot.insights && typeof b.snapshot.insights.window_days==='number' && b.snapshot.insights.by_source && typeof b.snapshot.insights.by_interest==='object'" \
  "$WORKER/api/data" -H "$(auth $T_SERVICE)"
expect "service: the rest of the snapshot is intact" 200 \
  "b.snapshot.units.length===39 && b.snapshot.leads.length===14 && b.snapshot.leads_summary.received_uncontacted===2" \
  "$WORKER/api/data" -H "$(auth $T_SERVICE)"
expect "sales KEEPS the money, and the lead log with it" 200 \
  "b.snapshot.leads.some(l=>typeof l.value==='number') && b.snapshot.leads.some(l=>typeof l.potential_commission==='number') && b.snapshot.scoreboard.money && b.snapshot.leads_summary.commission_rates && b.snapshot.leads.some(l=>Array.isArray(l.log) && l.log.length>0)" \
  "$WORKER/api/data" -H "$(auth $T_SALES)"
expect "owner KEEPS the money" 200 \
  "b.snapshot.scoreboard.money && typeof b.snapshot.scoreboard.money.on_table_commission==='number'" \
  "$WORKER/api/data" -H "$(auth $T_OWNER)"

echo "-- documents (schema 6): the doc id IS the sha256 of the bytes"
PDF="${PDF:-$(dirname "$0")/../test/fixtures/sample-quote.pdf}"
if [ ! -f "$PDF" ]; then
  bad "document fixture" "missing $PDF"
else
DOC_ID=$(node -e "const c=require('node:crypto'),f=require('node:fs');console.log(c.createHash('sha256').update(f.readFileSync(process.argv[1])).digest('hex').slice(0,16))" "$PDF")
WRONG_ID="0123456789abcdef"
H_DOC=(-H "X-Admin-Secret: $ADMIN_SECRET" -H "Content-Type: application/pdf" -H "X-Doc-Name: 2026-09-07-Fixture-Quote.pdf")

expect "docs listing baseline -> 200" 200 "Array.isArray(b.docs)" "$WORKER/api/admin/docs" -H "X-Admin-Secret: $ADMIN_SECRET"
DOCS_BEFORE=$(node -e "console.log(JSON.parse(process.argv[1]).docs.length)" "$LAST")

expect "PUT without secret -> 401"        401 "" -X PUT "$WORKER/api/admin/doc/$DOC_ID" -H "Content-Type: application/pdf" -H "X-Doc-Name: x.pdf" --data-binary "@$PDF"
expect "bad doc id shape -> 400"          400 "" -X PUT "$WORKER/api/admin/doc/NOTHEXAT-ALL" "${H_DOC[@]}" --data-binary "@$PDF"
expect "wrong content-type -> 415"        415 "" -X PUT "$WORKER/api/admin/doc/$DOC_ID" \
  -H "X-Admin-Secret: $ADMIN_SECRET" -H "Content-Type: text/plain" -H "X-Doc-Name: x.txt" --data-binary 'hello'
expect "missing X-Doc-Name -> 400"        400 "" -X PUT "$WORKER/api/admin/doc/$DOC_ID" \
  -H "X-Admin-Secret: $ADMIN_SECRET" -H "Content-Type: application/pdf" --data-binary "@$PDF"
expect "a path separator in the name -> 400" 400 "" -X PUT "$WORKER/api/admin/doc/$DOC_ID" \
  -H "X-Admin-Secret: $ADMIN_SECRET" -H "Content-Type: application/pdf" -H "X-Doc-Name: ../etc/passwd" --data-binary "@$PDF"

# An 11 MB body is refused on size, before anything is hashed or stored.
BIG=$(mktemp); head -c 11534336 /dev/zero > "$BIG"
expect "11 MB body -> 413"                413 "" -X PUT "$WORKER/api/admin/doc/$DOC_ID" "${H_DOC[@]}" --data-binary "@$BIG"
rm -f "$BIG"

# THE test. The id is a claim about the bytes; the Worker checks it and stores
# nothing when it is wrong, because a poisoned id would be permanent.
expect "hash mismatch -> 409, and it names the right id" 409 \
  "b.error==='hash mismatch' && b.expected==='$DOC_ID'" \
  -X PUT "$WORKER/api/admin/doc/$WRONG_ID" "${H_DOC[@]}" --data-binary "@$PDF"
expect "...and nothing was stored under the claimed id" 404 "" \
  "$WORKER/api/admin/doc/$WRONG_ID" -H "X-Admin-Secret: $ADMIN_SECRET"

expect "PUT the real bytes -> 201" 201 "b.id==='$DOC_ID' && b.bytes>0" \
  -X PUT "$WORKER/api/admin/doc/$DOC_ID" "${H_DOC[@]}" --data-binary "@$PDF"
expect "PUT it again -> 200 existed:true (docs are immutable)" 200 "b.id==='$DOC_ID' && b.existed===true" \
  -X PUT "$WORKER/api/admin/doc/$DOC_ID" "${H_DOC[@]}" --data-binary "@$PDF"
expect "listing gained exactly one, ours" 200 \
  "b.docs.length===$DOCS_BEFORE+1 && b.docs.filter(x=>x.id==='$DOC_ID').length===1 && b.docs.find(x=>x.id==='$DOC_ID').source==='vault' && b.docs.find(x=>x.id==='$DOC_ID').actor==='engine'" \
  "$WORKER/api/admin/docs" -H "X-Admin-Secret: $ADMIN_SECRET"

# The crew read. ?t= has to work: this is opened in a new tab, which cannot
# send a header. A service token gets it — docs are never role-gated.
expecth "GET /api/doc?t=<service> -> 200 application/pdf" 200 "^content-type: application/pdf" \
  "$WORKER/api/doc/$DOC_ID?t=$T_SERVICE"
expecth "...and inline, with the stored filename" 200 'content-disposition: inline; filename="2026-09-07-Fixture-Quote.pdf"' \
  "$WORKER/api/doc/$DOC_ID?t=$T_SERVICE"
expecth "...immutable, private, nosniff" 200 "^cache-control: private, max-age=31536000, immutable" \
  "$WORKER/api/doc/$DOC_ID?t=$T_SERVICE"
expecth "...nosniff" 200 "^x-content-type-options: nosniff" "$WORKER/api/doc/$DOC_ID?t=$T_SERVICE"
expecth "Bearer-only GET also works" 200 "^content-type: application/pdf" \
  "$WORKER/api/doc/$DOC_ID" -H "$(auth $T_OWNER)"
expect "no token -> 401"                  401 "" "$WORKER/api/doc/$DOC_ID"
expect "unknown id -> 404"                404 "" "$WORKER/api/doc/ffffffffffffffff" -H "$(auth $T_SALES)"
expect "bad id shape -> 400"              400 "" "$WORKER/api/doc/xyz" -H "$(auth $T_SALES)"
expect "POST to a doc -> 405 (upload is S2)" 405 "" -X POST "$WORKER/api/doc/$DOC_ID" -H "$(auth $T_OWNER)"

# The bytes came back byte-identical — that is the whole point of a hash id.
curl -sS -o /tmp/m1doc.$$ "$WORKER/api/doc/$DOC_ID?t=$T_OWNER"
BACK=$(node -e "const c=require('node:crypto'),f=require('node:fs');console.log(c.createHash('sha256').update(f.readFileSync(process.argv[1])).digest('hex').slice(0,16))" "/tmp/m1doc.$$")
rm -f "/tmp/m1doc.$$"
if [ "$BACK" = "$DOC_ID" ]; then ok "the bytes read back hash to the same id"
else bad "the bytes read back hash to the same id" "got $BACK, wanted $DOC_ID"; fi

expect "DELETE -> 200"                    200 "b.id==='$DOC_ID' && b.deleted===true" \
  -X DELETE "$WORKER/api/admin/doc/$DOC_ID" -H "X-Admin-Secret: $ADMIN_SECRET"
expect "...then GET -> 404"               404 "" "$WORKER/api/doc/$DOC_ID?t=$T_SERVICE"
expect "...DELETE again -> 404"           404 "" -X DELETE "$WORKER/api/admin/doc/$DOC_ID" -H "X-Admin-Secret: $ADMIN_SECRET"
expect "...and the listing is back to baseline" 200 "b.docs.length===$DOCS_BEFORE" \
  "$WORKER/api/admin/docs" -H "X-Admin-Secret: $ADMIN_SECRET"

echo
# Runs AFTER the S1 section has emptied the store, deliberately: the fixture is
# the same file, so the same bytes are the same document. Uploading it as crew
# while the vault's copy was still there would (correctly) answer existed:true
# and prove nothing about the crew write path.
echo "-- documents from a phone (S2): POST /api/doc + doc_attach"
PHOTO="${PHOTO:-$(dirname "$0")/../test/fixtures/sample-photo.png}"
PHOTO_ID=$(node -e "const c=require('node:crypto'),f=require('node:fs');console.log(c.createHash('sha256').update(f.readFileSync(process.argv[1])).digest('hex').slice(0,16))" "$PHOTO")
H_UP=(-H "$(auth $T_SERVICE)" -H "Content-Type: application/pdf" -H "X-Doc-Name: IMG_4821.pdf" -H "X-Doc-Record: S1018" -H "X-Doc-Kind: WORKORDER")

expect "upload without a token -> 401"     401 "" -X POST "$WORKER/api/doc" \
  -H "Content-Type: application/pdf" -H "X-Doc-Name: x.pdf" -H "X-Doc-Record: S1018" -H "X-Doc-Kind: WORKORDER" --data-binary "@$PDF"
expect "no X-Doc-Record -> 400"            400 "" -X POST "$WORKER/api/doc" -H "$(auth $T_SERVICE)" \
  -H "Content-Type: application/pdf" -H "X-Doc-Name: x.pdf" -H "X-Doc-Kind: WORKORDER" --data-binary "@$PDF"
expect "X-Doc-Record: X1 -> 400"           400 "" -X POST "$WORKER/api/doc" -H "$(auth $T_SERVICE)" \
  -H "Content-Type: application/pdf" -H "X-Doc-Name: x.pdf" -H "X-Doc-Record: X1" -H "X-Doc-Kind: WORKORDER" --data-binary "@$PDF"
# A phone may not mint the vault's kinds. QUOTE comes from the engine, always.
expect "X-Doc-Kind: QUOTE -> 400"          400 "" -X POST "$WORKER/api/doc" -H "$(auth $T_SERVICE)" \
  -H "Content-Type: application/pdf" -H "X-Doc-Name: x.pdf" -H "X-Doc-Record: S1018" -H "X-Doc-Kind: QUOTE" --data-binary "@$PDF"
expect "no X-Doc-Kind -> 400"              400 "" -X POST "$WORKER/api/doc" -H "$(auth $T_SERVICE)" \
  -H "Content-Type: application/pdf" -H "X-Doc-Name: x.pdf" -H "X-Doc-Record: S1018" --data-binary "@$PDF"
expect "no X-Doc-Name -> 400"              400 "" -X POST "$WORKER/api/doc" -H "$(auth $T_SERVICE)" \
  -H "Content-Type: application/pdf" -H "X-Doc-Record: S1018" -H "X-Doc-Kind: WORKORDER" --data-binary "@$PDF"
expect "text/plain -> 415"                 415 "" -X POST "$WORKER/api/doc" -H "$(auth $T_SERVICE)" \
  -H "Content-Type: text/plain" -H "X-Doc-Name: x.txt" -H "X-Doc-Record: S1018" -H "X-Doc-Kind: OTHER" --data-binary 'hello'
BIG2=$(mktemp); head -c 11534336 /dev/zero > "$BIG2"
expect "11 MB upload -> 413"               413 "" -X POST "$WORKER/api/doc" "${H_UP[@]}" --data-binary "@$BIG2"
rm -f "$BIG2"

# The client never names an id — the Worker hashes the bytes, and that IS the id.
expect "a tech uploads a PDF -> 201, id computed from the bytes" 201 \
  "b.id==='$DOC_ID' && b.bytes>0 && b.existed===false" \
  -X POST "$WORKER/api/doc" "${H_UP[@]}" --data-binary "@$PDF"
expect "the record binding lives in docmeta, not only in the event" 200 \
  "(()=>{const d=b.docs.find(x=>x.id==='$DOC_ID'); return d && d.record==='S1018' && d.kind==='WORKORDER' && d.source==='crew' && d.actor==='Test Josh' && d.mime==='application/pdf' && d.name==='IMG_4821.pdf';})()" \
  "$WORKER/api/admin/docs" -H "X-Admin-Secret: $ADMIN_SECRET"
# Double-tap protection, free: same bytes = same id = one document.
expect "the same file again -> 200 existed:true" 200 "b.id==='$DOC_ID' && b.existed===true" \
  -X POST "$WORKER/api/doc" "${H_UP[@]}" --data-binary "@$PDF"
expect "...and it is still ONE doc in the listing" 200 \
  "b.docs.filter(x=>x.id==='$DOC_ID').length===1" \
  "$WORKER/api/admin/docs" -H "X-Admin-Secret: $ADMIN_SECRET"
# A PNG from the camera roll — the other MIME branch.
expect "sales uploads a PNG against a LEAD -> 201" 201 "b.id==='$PHOTO_ID' && b.existed===false" \
  -X POST "$WORKER/api/doc" -H "$(auth $T_SALES)" -H "Content-Type: image/png" \
  -H "X-Doc-Name: WO-L1005-20260908-1432.png" -H "X-Doc-Record: L1005" -H "X-Doc-Kind: PHOTO" --data-binary "@$PHOTO"
expecth "a tech can read back what he just uploaded" 200 "^content-type: application/pdf" \
  "$WORKER/api/doc/$DOC_ID?t=$T_SERVICE"

echo "-- doc_attach: the tenth write action"
expect "doc_attach with an unknown doc_id -> 400" 400 "" -X POST "$WORKER/api/event" -H "$(auth $T_SERVICE)" -H "Content-Type: application/json" \
  -d '{"action":"doc_attach","payload":{"record":"S1018","doc_id":"ffffffffffffffff","kind":"WORKORDER","name":"x.pdf"}}'
expect "doc_attach with a bad doc_id shape -> 400" 400 "" -X POST "$WORKER/api/event" -H "$(auth $T_SERVICE)" -H "Content-Type: application/json" \
  -d '{"action":"doc_attach","payload":{"record":"S1018","doc_id":"../snapshot","kind":"WORKORDER","name":"x.pdf"}}'
expect "doc_attach with a bad record -> 400" 400 "" -X POST "$WORKER/api/event" -H "$(auth $T_SERVICE)" -H "Content-Type: application/json" \
  -d "{\"action\":\"doc_attach\",\"payload\":{\"record\":\"X1\",\"doc_id\":\"$DOC_ID\",\"kind\":\"WORKORDER\",\"name\":\"x.pdf\"}}"
expect "doc_attach with a vault-only kind -> 400" 400 "" -X POST "$WORKER/api/event" -H "$(auth $T_SERVICE)" -H "Content-Type: application/json" \
  -d "{\"action\":\"doc_attach\",\"payload\":{\"record\":\"S1018\",\"doc_id\":\"$DOC_ID\",\"kind\":\"QUOTE\",\"name\":\"x.pdf\"}}"
expect "a tech attaches it -> 201, server-stamped" 201 \
  "b.action==='doc_attach' && b.actor==='Test Josh' && b.role==='service' && b.serial===null && b.id && b.ts && b.payload.record==='S1018' && b.payload.doc_id==='$DOC_ID' && b.payload.kind==='WORKORDER' && b.payload.name==='IMG_4821.pdf'" \
  -X POST "$WORKER/api/event" -H "$(auth $T_SERVICE)" -H "Content-Type: application/json" \
  -d "{\"action\":\"doc_attach\",\"payload\":{\"record\":\"S1018\",\"doc_id\":\"$DOC_ID\",\"kind\":\"WORKORDER\",\"name\":\"IMG_4821.pdf\"}}"
D1=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")
expect "sales attaches the photo to a lead -> 201" 201 "b.payload.record==='L1005' && b.payload.kind==='PHOTO'" \
  -X POST "$WORKER/api/event" -H "$(auth $T_SALES)" -H "Content-Type: application/json" \
  -d "{\"action\":\"doc_attach\",\"payload\":{\"record\":\"L1005\",\"doc_id\":\"$PHOTO_ID\",\"kind\":\"PHOTO\",\"name\":\"site.png\"}}"
D2=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")
expect "the owner may attach too — it is any-role" 201 "b.role==='owner'" \
  -X POST "$WORKER/api/event" -H "$(auth $T_OWNER)" -H "Content-Type: application/json" \
  -d "{\"action\":\"doc_attach\",\"payload\":{\"record\":\"S1018\",\"doc_id\":\"$DOC_ID\",\"kind\":\"OTHER\",\"name\":\"note.pdf\"}}"
D3=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")
expect "all three doc_attach events drained -> deleted 3" 200 "b.deleted===3" \
  -X POST "$WORKER/api/admin/events/ack" "${H_ADMIN[@]}" \
  -d "{\"ids\":[\"$D1\",\"$D2\",\"$D3\"]}"
expect "pending back to baseline after the attaches" 200 "b.pending_count===$BEFORE" "$WORKER/api/health" -H "$(auth $T_OWNER)"

expect "the crew PNG is deleted -> 200" 200 "b.deleted===true" \
  -X DELETE "$WORKER/api/admin/doc/$PHOTO_ID" -H "X-Admin-Secret: $ADMIN_SECRET"

expect "the crew PDF is deleted -> 200" 200 "b.deleted===true" \
  -X DELETE "$WORKER/api/admin/doc/$DOC_ID" -H "X-Admin-Secret: $ADMIN_SECRET"
expect "the doc store is back to baseline" 200 "b.docs.length===$DOCS_BEFORE" \
  "$WORKER/api/admin/docs" -H "X-Admin-Secret: $ADMIN_SECRET"
fi

echo
echo "-- misc"
expect "unknown route -> 404"             404 "" "$WORKER/api/nope" -H "$(auth $T_OWNER)"
expect "wrong method -> 405"              405 "" -X POST "$WORKER/api/data" -H "$(auth $T_OWNER)"
expect "CORS preflight from Pages origin -> 204" 204 "" -X OPTIONS "$WORKER/api/data" \
  -H "Origin: https://mlancourt.github.io" -H "Access-Control-Request-Method: GET"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
