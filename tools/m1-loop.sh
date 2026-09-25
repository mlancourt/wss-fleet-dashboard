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
# sixteen write actions: the six schema-3 (D47's NEEDS-QUOTE stage included),
# three schema-5 ones, doc_attach (schema 6 / S2), rental_update (D64),
# work_order (D65, with its by-name money refusal), inspection (D67), and the
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
expect "publish mock snapshot -> 200"     200 "b.ok===true && b.units===39 && b.schema_version===7" \
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
# D55 — PO-RECEIVED. The Worker takes the stage and the `po` string; whether the
# lead may legally enter it WITHOUT one is the vault's call, not this file's.
expect "sales moves a lead to PO-RECEIVED with a po -> 201" 201 \
  "b.payload.lead==='L1015' && b.payload.stage==='PO-RECEIVED' && b.payload.po==='PO-48812'" \
  -X POST "$WORKER/api/event" -H "$(auth $T_SALES)" -H "Content-Type: application/json" \
  -d '{"action":"lead_update","payload":{"lead":"L1015","stage":"PO-RECEIVED","po":"  PO-48812 ","note":"Order in with the factory"}}'
L5I=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")
# Shape only: a bare PO-RECEIVED passes the Worker and the ENGINE refuses it.
expect "a bare PO-RECEIVED still passes the Worker (state is the vault's)" 201 \
  "b.payload.stage==='PO-RECEIVED' && b.payload.po===undefined" \
  -X POST "$WORKER/api/event" -H "$(auth $T_SALES)" -H "Content-Type: application/json" \
  -d '{"action":"lead_update","payload":{"lead":"L1015","stage":"PO-RECEIVED"}}'
L5J=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")
expect "a 65-char po -> 400"               400 "" -X POST "$WORKER/api/event" -H "$(auth $T_SALES)" -H "Content-Type: application/json" \
  -d '{"action":"lead_update","payload":{"lead":"L1015","stage":"PO-RECEIVED","po":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}'
expect "an unknown lead stage is still refused -> 400" 400 "" -X POST "$WORKER/api/event" -H "$(auth $T_SALES)" -H "Content-Type: application/json" \
  -d '{"action":"lead_update","payload":{"lead":"L1015","stage":"PO-PENDING","po":"PO-1"}}'
expect "the two PO events drained -> deleted 2" 200 "b.deleted===2" \
  -X POST "$WORKER/api/admin/events/ack" "${H_ADMIN[@]}" -d "{\"ids\":[\"$L5I\",\"$L5J\"]}"

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

echo "-- crew: rental_update (D64) — the fourteenth action"
RU() { echo "{\"action\":\"rental_update\",\"payload\":$1}"; }
expect "service may not touch a rental -> 403" 403 "" -X POST "$WORKER/api/event" -H "$(auth $T_SERVICE)" -H "Content-Type: application/json" \
  -d "$(RU '{"agreement":"R092526A","action":"OFF-RENT"}')"
expect "a bad verb -> 400"                 400 "" -X POST "$WORKER/api/event" -H "$(auth $T_SALES)" -H "Content-Type: application/json" \
  -d "$(RU '{"agreement":"R092526A","action":"ENDED"}')"
expect "a lower-case verb -> 400"          400 "" -X POST "$WORKER/api/event" -H "$(auth $T_SALES)" -H "Content-Type: application/json" \
  -d "$(RU '{"agreement":"R092526A","action":"out"}')"
expect "no agreement -> 400"               400 "" -X POST "$WORKER/api/event" -H "$(auth $T_SALES)" -H "Content-Type: application/json" \
  -d "$(RU '{"action":"OUT"}')"
expect "a traversal-shaped agreement -> 400" 400 "" -X POST "$WORKER/api/event" -H "$(auth $T_SALES)" -H "Content-Type: application/json" \
  -d "$(RU '{"agreement":"../evt","action":"OUT"}')"
expect "a fractional agreement -> 400"     400 "" -X POST "$WORKER/api/event" -H "$(auth $T_SALES)" -H "Content-Type: application/json" \
  -d "$(RU '{"agreement":4211.5,"action":"OUT"}')"
expect "a malformed date -> 400"           400 "" -X POST "$WORKER/api/event" -H "$(auth $T_SALES)" -H "Content-Type: application/json" \
  -d "$(RU '{"agreement":"R092526A","action":"OFF-RENT","date":"9/26/2026"}')"
LONG_NOTE=$(printf 'a%.0s' $(seq 1 201))
expect "a 201-char note -> 400"            400 "" -X POST "$WORKER/api/event" -H "$(auth $T_SALES)" -H "Content-Type: application/json" \
  -d "{\"action\":\"rental_update\",\"payload\":{\"agreement\":\"R092526A\",\"action\":\"OFF-RENT\",\"note\":\"$LONG_NOTE\"}}"
expect "sales takes a WSS-paper rental off-rent -> 201, id kept a string" 201 \
  "b.action==='rental_update' && b.serial===null && b.payload.agreement==='R092526A' && b.payload.action==='OFF-RENT' && b.payload.date==='2026-09-26' && b.payload.note==='Called at 8'" \
  -X POST "$WORKER/api/event" -H "$(auth $T_SALES)" -H "Content-Type: application/json" \
  -d "$(RU '{"agreement":"R092526A","action":"OFF-RENT","date":"2026-09-26","note":" Called at 8 "}')"
RU1=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")
expect "owner marks a legacy int back in shop -> 201, id kept an int" 201 \
  "b.payload.agreement===4211 && b.payload.action==='IN' && b.payload.date===null && b.payload.note===null" \
  -X POST "$WORKER/api/event" -H "$(auth $T_OWNER)" -H "Content-Type: application/json" \
  -d "$(RU '{"agreement":4211,"action":"IN"}')"
RU2=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")
expect "sales marks a customer pick-up OUT -> 201" 201 "b.payload.action==='OUT'" \
  -X POST "$WORKER/api/event" -H "$(auth $T_SALES)" -H "Content-Type: application/json" \
  -d "$(RU '{"agreement":"R092326B","action":"OUT","date":"2026-09-24"}')"
RU3=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")
expect "the undo valve applies (D46) -> 200" 200 "" -X DELETE "$WORKER/api/event/$RU3" -H "$(auth $T_SALES)"
expect "both remaining rental events drained -> deleted 2" 200 "b.deleted===2" \
  -X POST "$WORKER/api/admin/events/ack" "${H_ADMIN[@]}" -d "{\"ids\":[\"$RU1\",\"$RU2\"]}"
expect "pending back to baseline after the rentals" 200 "b.pending_count===$BEFORE" "$WORKER/api/health" -H "$(auth $T_OWNER)"

echo "-- crew: work_order (D65) — the fifteenth action, six verbs"
WO() { echo "{\"action\":\"work_order\"$1,\"payload\":$2}"; }
POSTWO() { local label="$1" want="$2" check="$3" tok="$4"; shift 4
  expect "$label" "$want" "$check" -X POST "$WORKER/api/event" -H "$(auth $tok)" -H "Content-Type: application/json" -d "$1"; }
OPEN_OK='{"action":"OPEN","purpose":"RENT-READY","note":"rent-ready for Acme Foods","parts":[{"manufacturer":"FACTORY-CAT","part_number":"150-4500","description":"Solution valve 24V","qty":1},{"manufacturer":"FACTORY-CAT","part_number":"21-422S","description":"Squeegee blade rear","qty":2}]}'
POSTWO "service opens a work order with two lines -> 201" 201 \
  "b.action==='work_order' && b.serial==='900233' && b.payload.action==='OPEN' && b.payload.purpose==='RENT-READY' && b.payload.parts.length===2 && b.payload.parts[1].qty===2" \
  "$T_SERVICE" "$(WO ',"serial":"900233"' "$OPEN_OK")"
WO1=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")
POSTWO "a labor-only OPEN (no parts) is legal -> 201" 201 "b.payload.parts.length===0 && b.payload.purpose==='PM'" \
  "$T_SALES" "$(WO ',"serial":"900107"' '{"action":"OPEN","purpose":"PM"}')"
WO2=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")
POSTWO "ADD-PARTS (any role) -> 201" 201 "b.serial===null && b.payload.work_order==='W1001' && b.payload.parts[0].description===null" \
  "$T_SALES" "$(WO '' '{"action":"ADD-PARTS","work_order":"W1001","parts":[{"manufacturer":"KODIAK","part_number":"30-750","qty":1}]}')"
WO3=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")
POSTWO "owner marks a line ORDERED -> 201" 201 \
  "b.payload.state==='ORDERED' && b.payload.line===1 && b.payload.vendor==='RPS' && b.payload.vendor_ref==='SO-448121'" \
  "$T_OWNER" "$(WO '' '{"action":"PART-STATE","work_order":"W1001","line":1,"state":"ORDERED","date":"2026-09-26","vendor":"RPS","vendor_ref":"SO-448121"}')"
WO4=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")
POSTWO "service marks a line IN-TRANSIT with tracking -> 201" 201 "b.payload.state==='IN-TRANSIT' && b.payload.tracking==='UPS 1Z999AA10123456784'" \
  "$T_SERVICE" "$(WO '' '{"action":"PART-STATE","work_order":"W1001","line":1,"state":"IN-TRANSIT","tracking":"UPS 1Z999AA10123456784"}')"
WO5=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")
POSTWO "service marks a line DELIVERED -> 201" 201 "b.payload.state==='DELIVERED'" \
  "$T_SERVICE" "$(WO '' '{"action":"PART-STATE","work_order":"W1001","line":1,"state":"DELIVERED","date":"2026-09-30"}')"
WO6=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")
POSTWO "LABOR 1.5 h for Zac, logged by Matt -> 201" 201 "b.payload.hours===1.5 && b.payload.who==='Zac' && b.actor==='Test Matt'" \
  "$T_OWNER" "$(WO '' '{"action":"LABOR","work_order":"W1001","date":"2026-09-25","who":"Zac","hours":1.5,"note":"squeegee rebuild"}')"
WO7=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")
POSTWO "owner CLOSEs -> 201" 201 "b.payload.action==='CLOSE' && b.payload.note===null" \
  "$T_OWNER" "$(WO '' '{"action":"CLOSE","work_order":"W1001","note":""}')"
WO8=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")
POSTWO "CANCEL passes the Worker for the opener (the engine referees it) -> 201" 201 "b.payload.action==='CANCEL'" \
  "$T_SERVICE" "$(WO '' '{"action":"CANCEL","work_order":"W1002","note":"found in shop stock"}')"
WO9=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")
expect "the undo valve applies to a work_order tap (D46) -> 200" 200 "" -X DELETE "$WORKER/api/event/$WO9" -H "$(auth $T_SERVICE)"
# Refusals — role
POSTWO "service may not mark a part ORDERED -> 403" 403 "" \
  "$T_SERVICE" "$(WO '' '{"action":"PART-STATE","work_order":"W1001","line":1,"state":"ORDERED"}')"
POSTWO "sales may not mark a part DELIVERED -> 403" 403 "" \
  "$T_SALES" "$(WO '' '{"action":"PART-STATE","work_order":"W1001","line":1,"state":"DELIVERED"}')"
POSTWO "service may not CLOSE -> 403" 403 "" "$T_SERVICE" "$(WO '' '{"action":"CLOSE","work_order":"W1001"}')"
# Refusals — shape
POSTWO "a 7th verb -> 400" 400 "" "$T_OWNER" "$(WO '' '{"action":"REOPEN","work_order":"W1001"}')"
ELEVEN=$(node -e "console.log(JSON.stringify({action:'OPEN',purpose:'REPAIR',parts:Array.from({length:11},(_,i)=>({manufacturer:'OTHER',part_number:'P'+i,qty:1}))}))")
POSTWO "an 11-line OPEN -> 400" 400 "" "$T_OWNER" "$(WO ',"serial":"900233"' "$ELEVEN")"
POSTWO "a bad manufacturer -> 400" 400 "" "$T_OWNER" \
  "$(WO ',"serial":"900233"' '{"action":"OPEN","purpose":"REPAIR","parts":[{"manufacturer":"ACME","part_number":"1","qty":1}]}')"
POSTWO "work_order S1001 -> 400" 400 "" "$T_OWNER" "$(WO '' '{"action":"CLOSE","work_order":"S1001"}')"
POSTWO "hours 13 -> 400"   400 "" "$T_OWNER" "$(WO '' '{"action":"LABOR","work_order":"W1001","who":"Josh","hours":13}')"
POSTWO "hours 1.3 -> 400"  400 "" "$T_OWNER" "$(WO '' '{"action":"LABOR","work_order":"W1001","who":"Josh","hours":1.3}')"
POSTWO "a backwards state (-> REQUESTED) -> 400" 400 "" "$T_OWNER" \
  "$(WO '' '{"action":"PART-STATE","work_order":"W1001","line":1,"state":"REQUESTED"}')"
POSTWO "OPEN without a serial -> 400" 400 "" "$T_OWNER" "$(WO '' '{"action":"OPEN","purpose":"PM"}')"
POSTWO "LABOR with a serial (keyed on work_order) -> 400" 400 "" "$T_OWNER" \
  "$(WO ',"serial":"900233"' '{"action":"LABOR","work_order":"W1001","who":"Josh","hours":1}')"
POSTWO "qty 0 -> 400" 400 "" "$T_OWNER" "$(WO '' '{"action":"ADD-PARTS","work_order":"W1001","parts":[{"manufacturer":"OTHER","part_number":"1","qty":0}]}')"
POSTWO "an unknown key on a part line -> 400" 400 "" "$T_OWNER" \
  "$(WO '' '{"action":"ADD-PARTS","work_order":"W1001","parts":[{"manufacturer":"OTHER","part_number":"1","qty":1,"bin":"A3"}]}')"
# THE D65 refusal: money, by name, at any depth, from any role
POSTWO "a cost key on a part line -> 400 naming it" 400 "b.error.includes('\"cost\"')" "$T_OWNER" \
  "$(WO '' '{"action":"ADD-PARTS","work_order":"W1001","parts":[{"manufacturer":"OTHER","part_number":"1","qty":1,"cost":42.5}]}')"
POSTWO "a rate key on LABOR -> 400 naming it" 400 "b.error.includes('\"rate\"')" "$T_OWNER" \
  "$(WO '' '{"action":"LABOR","work_order":"W1001","who":"Josh","hours":1,"rate":95}')"
POSTWO "a Price key on OPEN (any case) -> 400 naming it" 400 "b.error.includes('\"Price\"')" "$T_SERVICE" \
  "$(WO ',"serial":"900233"' '{"action":"OPEN","purpose":"REPAIR","Price":10}')"
POSTWO "a cost key on ANY action, not just work_order -> 400" 400 "b.error.includes('\"cost\"')" "$T_OWNER" \
  '{"action":"ticket_update","payload":{"ticket":"S1001","note":"x","cost":5}}'
# D68 — use from stock: source on a part line (OPEN / ADD-PARTS) and on PART-STATE
STK='{"manufacturer":"FACTORY-CAT","part_number":"264-4086","description":"filter","qty":1,"source":"SHOP-STOCK"}'
STK_OPEN='{"action":"OPEN","purpose":"REPAIR","parts":['"$STK"']}'
POSTWO "D68: service OPENs with a SHOP-STOCK line -> 201" 201 "b.payload.parts[0].source==='SHOP-STOCK'" \
  "$T_SERVICE" "$(WO ',"serial":"900233"' "$STK_OPEN")"
WO10=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")
POSTWO "D68: sales ADD-PARTS with source WARRANTY -> 201" 201 "b.payload.parts[0].source==='WARRANTY'" \
  "$T_SALES" "$(WO '' '{"action":"ADD-PARTS","work_order":"W1001","parts":[{"manufacturer":"KODIAK","part_number":"30-750","qty":1,"source":"WARRANTY"}]}')"
WO11=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")
POSTWO "D68: a bad parts[].source -> 400" 400 "" "$T_OWNER" \
  "$(WO '' '{"action":"ADD-PARTS","work_order":"W1001","parts":[{"manufacturer":"OTHER","part_number":"1","qty":1,"source":"SHELF"}]}')"
POSTWO "D68: service pulls a line from stock (no state) -> 201" 201 "b.payload.source==='SHOP-STOCK' && b.payload.state==='DELIVERED' && b.payload.note==='on the shelf'" \
  "$T_SERVICE" "$(WO '' '{"action":"PART-STATE","work_order":"W1002","line":1,"source":"SHOP-STOCK","note":"on the shelf"}')"
WO12=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")
POSTWO "D68: owner pulls from stock with state DELIVERED -> 201" 201 "b.payload.source==='SHOP-STOCK'" \
  "$T_OWNER" "$(WO '' '{"action":"PART-STATE","work_order":"W1002","line":2,"state":"DELIVERED","source":"SHOP-STOCK"}')"
WO13=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")
POSTWO "D68: sales may not pull from stock -> 403" 403 "" \
  "$T_SALES" "$(WO '' '{"action":"PART-STATE","work_order":"W1002","line":1,"source":"SHOP-STOCK"}')"
POSTWO "D68: source WARRANTY on PART-STATE -> 400" 400 "" \
  "$T_OWNER" "$(WO '' '{"action":"PART-STATE","work_order":"W1002","line":1,"source":"WARRANTY"}')"
POSTWO "D68: source SHOP-STOCK + state ORDERED -> 400" 400 "" \
  "$T_OWNER" "$(WO '' '{"action":"PART-STATE","work_order":"W1002","line":1,"state":"ORDERED","source":"SHOP-STOCK"}')"
POSTWO "D68: a cost key on a stock pull -> 400 naming it" 400 "b.error.includes('\"cost\"')" \
  "$T_SERVICE" "$(WO '' '{"action":"PART-STATE","work_order":"W1002","line":1,"source":"SHOP-STOCK","cost":12}')"
expect "all twelve work-order events drained -> deleted 12" 200 "b.deleted===12" \
  -X POST "$WORKER/api/admin/events/ack" "${H_ADMIN[@]}" \
  -d "{\"ids\":[\"$WO1\",\"$WO2\",\"$WO3\",\"$WO4\",\"$WO5\",\"$WO6\",\"$WO7\",\"$WO8\",\"$WO10\",\"$WO11\",\"$WO12\",\"$WO13\"]}"
expect "pending back to baseline after the work orders" 200 "b.pending_count===$BEFORE" "$WORKER/api/health" -H "$(auth $T_OWNER)"

echo "-- crew: inspection (D67) — the sixteenth action, five verbs"
IN() { echo "{\"action\":\"inspection\"$1,\"payload\":$2}"; }
POSTWO "service opens a check-out sheet -> 201" 201 "b.serial==='900233' && b.payload.action==='OPEN' && b.payload.kind==='CHECKOUT'" \
  "$T_SERVICE" "$(IN ',"serial":"900233"' '{"action":"OPEN","kind":"CHECKOUT"}')"
IN1=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")
POSTWO "SAVE one section (merge) -> 201" 201 "b.payload.inspection==='I1001' && b.payload.readings.hours_key===412.5 && !('items' in b.payload)" \
  "$T_SERVICE" "$(IN '' '{"action":"SAVE","inspection":"I1001","readings":{"hours_key":412.5}}')"
IN2=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")
POSTWO "DONE (any role) -> 201" 201 "b.payload.tech==='Zac'" "$T_SALES" "$(IN '' '{"action":"DONE","inspection":"I1001","tech":"Zac"}')"
IN3=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")
POSTWO "REOPEN -> 201 (who may is the engine's call)" 201 "" "$T_SERVICE" "$(IN '' '{"action":"REOPEN","inspection":"I1001","note":"missed a row"}')"
IN4=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")
POSTWO "VOID -> 201" 201 "" "$T_OWNER" "$(IN '' '{"action":"VOID","inspection":"I1001","note":"wrong unit"}')"
IN5=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")
POSTWO "work_order OPEN from a sheet carries inspection -> 201" 201 "b.payload.inspection==='I1001'" "$T_SERVICE" \
  "$(WO ',"serial":"900233"' '{"action":"OPEN","purpose":"REPAIR","inspection":"I1001","note":"from I1001: Check and rotate blades","parts":[]}')"
IN6=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")
POSTWO "a 6th verb -> 400" 400 "" "$T_OWNER" "$(IN '' '{"action":"SIGN","inspection":"I1001"}')"
POSTWO "inspection W1001 -> 400" 400 "" "$T_OWNER" "$(IN '' '{"action":"DONE","inspection":"W1001"}')"
POSTWO "sg 2.0 -> 400" 400 "" "$T_OWNER" "$(IN '' '{"action":"SAVE","inspection":"I1001","cells":[{"battery":1,"cell":"A","sg":2.0}]}')"
POSTWO "an unknown top-level key -> 400" 400 "b.error.includes('signature')" "$T_OWNER" "$(IN '' '{"action":"SAVE","inspection":"I1001","signature":"x"}')"
POSTWO "a result outside both scales -> 400" 400 "" "$T_OWNER" "$(IN '' '{"action":"SAVE","inspection":"I1001","items":[{"id":"ctl.key_switch","result":"FINE"}]}')"
POSTWO "OPEN without a serial -> 400" 400 "" "$T_OWNER" "$(IN '' '{"action":"OPEN","kind":"PM"}')"
POSTWO "D67c: DONE keyed on the serial -> 201" 201 "b.serial==='900233' && !('inspection' in b.payload) && b.payload.tech==='Josh'" "$T_SERVICE" "$(IN ',"serial":"900233"' '{"action":"DONE","tech":"Josh"}')"
IN7=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")
POSTWO "D67c: VOID keyed on the serial -> 201" 201 "b.serial==='900233' && !('inspection' in b.payload)" "$T_SERVICE" "$(IN ',"serial":"900233"' '{"action":"VOID","note":"wrong unit"}')"
IN8=$(node -e "console.log(JSON.parse(process.argv[1]).id)" "$LAST")
POSTWO "D67c: DONE with both serial and inspection -> 400" 400 "" "$T_SERVICE" "$(IN ',"serial":"900233"' '{"action":"DONE","inspection":"I1001"}')"
POSTWO "D67c: VOID with neither -> 400" 400 "" "$T_SERVICE" "$(IN '' '{"action":"VOID"}')"
POSTWO "D67c: REOPEN keyed on the serial -> 400" 400 "" "$T_OWNER" "$(IN ',"serial":"900233"' '{"action":"REOPEN"}')"
POSTWO "v1.2: the retired controls key -> 400" 400 "b.error.includes('controls')" "$T_OWNER" "$(IN '' '{"action":"SAVE","inspection":"I1001","controls":"RIDER"}')"
POSTWO "v1.2: a fractional brush percent -> 400" 400 "" "$T_OWNER" "$(IN '' '{"action":"SAVE","inspection":"I1001","readings":{"brush1_pct":55.5}}')"
POSTWO "v1.2: recharge_count is gone -> 400" 400 "" "$T_OWNER" "$(IN '' '{"action":"SAVE","inspection":"I1001","readings":{"recharge_count":8}}')"
expect "all eight inspection events drained -> deleted 8" 200 "b.deleted===8" \
  -X POST "$WORKER/api/admin/events/ack" "${H_ADMIN[@]}" \
  -d "{\"ids\":[\"$IN1\",\"$IN2\",\"$IN3\",\"$IN4\",\"$IN5\",\"$IN6\",\"$IN7\",\"$IN8\"]}"
expect "pending back to baseline after the inspections" 200 "b.pending_count===$BEFORE" "$WORKER/api/health" -H "$(auth $T_OWNER)"

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
  "b.snapshot.units.length===39 && b.snapshot.leads.length===15 && b.snapshot.leads_summary.received_uncontacted===2" \
  "$WORKER/api/data" -H "$(auth $T_SERVICE)"
# D55 — the committed_* trio lives INSIDE scoreboard.money, which the Worker
# deletes as a whole object. So there is no key list to keep in sync; this is the
# assertion that proves it, in both directions.
expect "service: no committed_* anywhere (scoreboard.money is deleted whole)" 200 \
  "!('money' in b.snapshot.scoreboard) && JSON.stringify(b.snapshot).indexOf('committed_')===-1" \
  "$WORKER/api/data" -H "$(auth $T_SERVICE)"
expect "sales: the committed_* trio survives" 200 \
  "typeof b.snapshot.scoreboard.money.committed_value==='number' && typeof b.snapshot.scoreboard.money.committed_commission==='number' && typeof b.snapshot.scoreboard.money.committed_count==='number'" \
  "$WORKER/api/data" -H "$(auth $T_SALES)"
expect "sales KEEPS the money, and the lead log with it" 200 \
  "b.snapshot.leads.some(l=>typeof l.value==='number') && b.snapshot.leads.some(l=>typeof l.potential_commission==='number') && b.snapshot.scoreboard.money && b.snapshot.leads_summary.commission_rates && b.snapshot.leads.some(l=>Array.isArray(l.log) && l.log.length>0)" \
  "$WORKER/api/data" -H "$(auth $T_SALES)"
expect "owner KEEPS the money" 200 \
  "b.snapshot.scoreboard.money && typeof b.snapshot.scoreboard.money.on_table_commission==='number'" \
  "$WORKER/api/data" -H "$(auth $T_OWNER)"
# D65: work orders carry no money for ANY role — no cost / rate / price key and
# no figure in the text. The builder never emits one; this holds it to that.
for RN in owner sales service; do
  case $RN in owner) R=$T_OWNER;; sales) R=$T_SALES;; service) R=$T_SERVICE;; esac
  expect "$RN: work_orders carry no money key, no /\\\$\\s?\\d/ in the text" 200 \
    "Array.isArray(b.snapshot.work_orders) && b.snapshot.work_orders.length>0 && !/\\\$\\s?\\d/.test(JSON.stringify(b.snapshot.work_orders)) && !/\"(cost|cost_source_inv|rate|price)\"/.test(JSON.stringify(b.snapshot.work_orders))" \
    "$WORKER/api/data" -H "$(auth $R)"
done

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
