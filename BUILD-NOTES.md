# BUILD-NOTES — v1.6 / schema 3 (Service module + Dispatch board)

Built Sep 3, 2026 from `Service-Dispatch-Site-Spec.md` (everything below its cut
line) against `CLAUDE.md` v1.6. **On mock data only.** Nothing was deployed, no
DNS/tokens/secrets touched, nothing pushed.

---

## What shipped

**Nav** is now Fleet · Rentals · Holds · **Dispatch** · Service.

- **Billing is gone.** `snapshot.billing` is no longer read anywhere in the app;
  it still arrives for the engine's own consumers. `#/billing` redirects to
  `#/dispatch` so old bookmarks and home-screen icons still land somewhere.
- **The D21 recurring-revenue block leads Rentals** — same math, same copy
  ("Recurring revenue — per 28-day cycle" / "≈ $X / month"), above the
  agreements list.
- **Service** — the D20 status board keeps the top, then `+ New ticket` (any
  role), All/Customer/Fleet filter chips, then an eight-stage kanban that swipes
  sideways on a phone (scroll-snap, sticky column headers) and opens to all
  eight columns side by side above 1040px. Cards carry customer, equipment (or
  serial + model for a fleet machine), a one-line issue, age, the assignee's
  initial, a 🚚 when the ticket has a live truck run, and a maroon left edge on
  HIGH. Closed tickets show greyed in COMPLETE only.
- **Ticket detail** — the whole record, then a stage picker (WAITING-ON-CUSTOMER and
  READY-TO-INVOICE hidden when `machine_owner: WSS`; COMPLETE on a customer
  ticket disabled for techs with the caption "Matt closes after invoicing."),
  note / assign / schedule, the ticket's dispatch rows, and an offer to book a
  move the ticket says it lacks.
- **Dispatch** — Open → Scheduled (grouped by day) → Done this week (collapsed).
  Claim takes driver / rig / day and warns inline when that rig already has that
  day; it never blocks. Done on a `RENTAL-RETURN` row says it ends the agreement.
  Add a run reaches from the board, from a unit page ("Schedule delivery",
  pre-filled from the placement) and from a hold row. Cancel is owner-only on
  MANUAL rows. Addresses are tap-to-copy — **no map links**. Nav badge = OPEN +
  SCHEDULED.
- **Unit page** — wrench chip + link when `service_ticket` is set, "Schedule
  delivery", and a NEEDS-PICKUP line pointing at the run's row on the board.
- **Worker** — the six new actions, validated for shape and enum membership
  only. `serial` optional on those six (normalised to `null`), still required
  for reserve / release / readiness.
- **Mock** — `make-mock-data.js` emits schema 3 with every case §9 names, plus
  `mock-legacy.json` (the schema-2 downgrade) for the cutover.

## Tests

`npm test` — six suites, ~85 checks, green under `TZ=Pacific/Pago_Pago` too.
The new one, `selftest-render.mjs`, boots the **real** `app.js` in a stub DOM
and renders every route × all three mock variants × all three roles, failing on
a thrown view, a leaked `undefined`, or a `Date`-parsed date-only string.

`npm run m1` against `wrangler dev` — **62 passed, 0 failed**, including all
nine write actions and their refusals.

The §10 exit walkthrough was run end to end against the local Worker: Josh
opens a customer ticket with "we pick it up" → Kevin claims it with
TRAILER-6000 → Josh marks it done → Josh walks the stages to READY-TO-INVOICE →
Matt completes it → Kevin adds a manual run → Matt cancels it. All six new
actions exercised; every event landed as an `evt:` key and drained cleanly.

Also checked in headless Chrome at 390×844: the conditional New-ticket form,
the rig-clash warning, the rental-return Done copy, role gating on Cancel, and
zero console errors (the only 404 is the browser's own `/favicon.ico`, which
predates this work).

---

## Decisions I made

Where the spec left it to me, or left a gap:

1. **No separate Pick-ups block on Dispatch.** §1 says the block "moves into
   Dispatch" and "is now just the `RENTAL-RETURN` rows of `dispatch[]`", while
   §4 defines exactly three sections. I read those together as: RENTAL-RETURN
   rows live in the normal Open/Scheduled sections, marked with the 📦 source
   glyph and a "billed through" line. There is no fourth block. Category cards
   keep their `· N to pick up` sub-line from `pickups[]`, unchanged.

2. **Added a "Released, not on the board" guard.** A `pickups[]` entry whose
   serial has no live RENTAL-RETURN row would otherwise be invisible now that
   the pick-ups list is gone. It renders as a small loud block above Scheduled
   with an "Add the run" button. Normally empty — it exists so a machine on a
   customer's dock can't go quiet because a row is missing. It is also what
   makes the schema-2 snapshot still show released units during the cutover.

3. **`intake_move` when the machine is already in our shop.** §3.1 hides the
   question when `location: IN-SHOP` but doesn't say what to send. The form
   sends `NONE` — there is no truck move to arrange for something already here.
   The picker's three options only appear for AT-CUSTOMER, as specified.

4. **The kanban column count comes from `service_summary.open_by_stage` only
   when no filter is applied.** Under a Customer/Fleet filter that number would
   be a lie, so the column counts what it draws. The filter chips themselves
   show `open_customer` / `open_wss` from the summary.

5. **A pending `ticket_open` does not inflate the RECEIVED column count.** It
   renders as the synthetic ⏳ NEW card §3.1 asks for, but the header count
   stays the engine's number — the count is applied truth, the card is the
   proposal.

6. **Assign offers the four names as a segmented control, submitted like any
   other sheet** (rather than a tap posting immediately). One mis-tap should
   not become a proposal.

7. **Stage picker: tapping a stage opens a sheet with an optional note**, per
   §3.3, rather than posting on tap. Same reasoning.

8. **`mock-legacy.json` is a third mock variant** (`?mock=legacy`), added to
   `MOCK_VARIANTS` in `docs/api.js`. §9 said to keep the schema-2 variant for
   one release; rather than freeze a stale file, it is generated as a downgrade
   of the schema-3 snapshot, so it stays coherent. **Delete it after the
   cutover** — the README says where.

9. **`#/billing` redirects rather than 404s.** Not in the spec; the crew has
   home-screen icons and bookmarks.

10. **A test seam in `app.js`** (`__render`, `__refresh`, `__state` exports) so
    `selftest-render.mjs` can drive the real views. Three lines, nothing in the
    page reads them, and it is what catches a view that throws before a phone
    in a warehouse does.

---

## Things worth flagging

**None of these blocked the build.**

- **The Worker cannot enforce "only Matt closes a customer ticket."** Deciding
  that needs `machine_owner` for ticket `S1001`, which means reading the
  snapshot — business state, explicitly not the Worker's job (§7: "never
  business state"). So the Worker accepts `{stage: COMPLETE}` from a tech; the
  **UI hides the button** and the **engine refuses it**. That matches §6's
  "client-side convenience only — the engine enforces", but it is worth the
  Architect knowing the server is not a backstop for this one rule. The Worker
  *does* enforce the two rules it can see from the event alone: a
  `ticket_update` carrying `stage` needs service/owner, and `dispatch_cancel`
  is owner-only. (§7 says "no other Worker changes"; enforcing these two is
  stricter than the letter of §7 but matches the rules stated in both §6 and
  CLAUDE.md. Say the word and they come out.)

- **`driverChoices` falls back to all four names for an unrecognised user.**
  §4 says non-owners "see only themselves", keyed on the person's name. In mock
  mode `me.name` is "Mock User", which is not one of the four, so the picker
  shows all four rather than nothing. With a real token (name "Josh") a tech
  sees only Josh. If a fifth person is ever added to the token map without being
  added to `DRIVERS`, they will see all four rather than an empty picker — a
  deliberate choice, since an empty picker is unusable.

- **`ticket_update` cannot clear a field.** The Worker drops empty values so
  "only the keys being changed" travel (§6). There is therefore no way to
  un-assign a ticket or clear a scheduled date from the UI. The spec doesn't ask
  for one; noting it in case the crew asks.

- **`age_days` and `stage_since` are rendered verbatim from the snapshot** — no
  client-side date arithmetic, per rule 7. If the engine ships a stale
  `age_days` the board shows a stale number rather than quietly recomputing it.

- **One `?mock=` value was added** (`legacy`). `selftest-api.mjs` still proves
  the whole mock gate is inert on a real host with the Worker wired.

---

## For the real-snapshot smoke test

When the Architect says schema 3 is live, in this order:

1. **`GET /api/health`** — confirm `published_at` moved and the run is fresh.
2. **Open the tokened URL on a phone.** Header reads "data as of …" with no ⚠️.
3. **Service tab** — the D20 board still sums to the fleet; the eight columns
   carry real tickets; column counts match `service_summary.open_by_stage`.
   Check a `machine_owner: WSS` ticket hides WAITING-ON-CUSTOMER and READY-TO-INVOICE.
4. **A fleet unit with an open ticket** shows the 🔧 chip and the chip links to
   a ticket that exists. If a unit's `service_ticket` names a ticket that isn't
   in `service_queue`, the detail page says "Ticket not found" — **report it,
   don't patch it.**
5. **Dispatch tab** — the badge equals OPEN + SCHEDULED. Every RENTAL-RETURN row
   shows a `billed_through` date. **If "Released, not on the board" is
   non-empty on real data, that is a finding for the Architect**, not a bug
   here: it means `pickups[]` and `dispatch[]` disagree.
6. **Dates.** Spot-check one `scheduled`, one `date`, one `billed_through`,
   one `opened` against the vault. An off-by-one day is the disqualifying bug.
7. **Money.** The Rentals headline against the vault's own recurring total.
8. **Real ids.** Mock uses `S1001` and `m-pu-<serial>`; the engine's real
   `ticket` and `dispatch.id` shapes are treated as opaque strings, but the
   Worker's `REF_ID_RE` allows `[A-Za-z0-9_.-]{1,64}` — if real ids carry any
   other character, claims and updates will 400. Worth one look at a real id
   before the crew starts tapping.
9. **One live write per role**, ideally the §10 walkthrough on real data: Josh
   opens a ticket, Kevin claims a run, Matt cancels a manual one. Confirm each
   lands in `GET /api/admin/events` and badges ⏳ on the board.
10. **`dispatch_warnings`** — if the engine ever sends one, confirm the claim
    sheet surfaces it and still lets the claim through.

Then delete `mock-legacy.json` and its wiring (README says where), and set the
v1.6 row in the README status table to live.

---

# D43 — Service Pipeline widget + filter-driven Service tab (2026-09-04)

Built from `Service-Pipeline-Widget-Site-Spec.md` (below its cut line) against
`CLAUDE.md` v1.7. **Site-only, as the order says** — no snapshot, Worker or
event changes, and no `wrangler deploy`. Everything is computed on the client
from `service_queue[]` and `service_summary`, the way the Fleet Status board is
computed from `units[]`.

## What shipped

**Service tab, top to bottom:** `+ New ticket` · filter chips · widget zone ·
kanban.

- **Chips reordered to `All · Fleet · Customer`**, All default, counts as
  before. The choice is remembered per device (`localStorage`, try/catch,
  falling back to All on anything unexpected) so a tech who lives in Fleet
  lands there. Verified across a full page reload in a real browser.
- **Widget zone by chip** — All: Fleet Status then Service Pipeline, with the
  muted caption "Customer machines · fleet repairs are on the board above";
  Fleet: the board alone; Customer: the pipeline alone.
- **Kanban** — under Fleet it drops WAITING-ON-CUSTOMER and READY-TO-INVOICE
  (six columns); All and Customer show all eight.
- **Service Pipeline widget** — a sibling of the fleet board: same card, same
  row anatomy, same typography. Seven rows in stage order over **open CUSTOMER
  tickets**, one shared 100% scale, zero rows still drawn. Header pill `N open`
  plus a muted `N closed this week` that hides at zero. COMPLETE is the pill,
  never a row. Rows are buttons: tapping one scrolls the kanban to that column
  and never changes the chip.
- **`docs/service.js`** gained `pipeline(queue)` and `columnsFor(filter)`, both
  pure. `BUILD` stamp and SW cache bumped (v11 → v12).

## Tests

`npm test` — 80 checks green, also under `TZ=Pacific/Pago_Pago`. Seven new
assertions in `selftest-service.mjs` (row order, counts and pct on a mixed
queue, fleet tickets excluded, closed-this-week from `status`, `columnsFor`
dropping exactly the two stages, empty queue → seven zero rows) and six in
`selftest-render.mjs` (chip order, each chip's widgets and column count, only
the right tickets drawn under each, seven tappable rows with a live pill, chip
persistence across a re-boot, and the card never hiding on an empty snapshot).

Browser-verified at 390×844: chip order, widgets per chip, six-vs-eight
columns, persistence across a full reload, row tap scrolling without
re-filtering, and zero console exceptions.

## Decisions I made

1. **`columnsFor('WSS')` is `stagesFor('WSS')`.** The kanban's six columns and
   the ticket-detail stage picker are the same rule; deriving one from the
   other means they cannot drift if the hidden set ever changes.

2. **A hidden column still appears if a ticket is actually in it.** Under Fleet,
   if the engine ever parks a WSS ticket in WAITING-ON-CUSTOMER, that column is
   appended rather than the ticket vanishing. Hiding a column is a display
   choice; dropping a ticket is data loss, and `columnize` already promised
   never to do it.

3. **The widgets survive an empty queue; only the kanban is replaced.** The old
   code returned early on an empty `service_queue` and drew nothing but the
   empty state. The spec says the pipeline card must never hide, so the empty
   state now replaces the kanban alone and the shop's shape still reads.

4. **The pipeline's label column is wider than the fleet board's.** At 390px,
   "Waiting on customer" ran into the count. The bar gives up those pixels
   rather than the label being truncated — the seven bars share one scale, so
   they're read against each other, not measured. Row heights stay uniform
   (40px), which is what "stable layout" is protecting.

5. **The `closed this week` pill hides at zero** rather than reading "0 closed
   this week" — the order left this to me.

6. **Row tap never changes the chip**, under any chip. The spec only requires
   this for All and Fleet; making it unconditional means the widget is a way to
   read the board and never a second, hidden filter.

7. **Chip persistence is separate from the token/API storage keys**
   (`wss_fleet_service_filter`), and every read and write is wrapped — a device
   with storage blocked simply gets All every time, no error path.

## Things worth flagging

**None blocking.**

- **`columnize`'s "unknown stage" behaviour narrowed slightly.** It used to scan
  the whole queue for stages it didn't recognise; it now scans the tickets the
  current filter actually renders. Same guarantee (no ticket is ever dropped),
  but a stage occupied only by tickets the filter hides no longer produces an
  empty column — which is the point of the Fleet six-column view.

- **The `N open` chip counts and the pipeline's `N open` come from different
  places** — the chips prefer `service_summary.open_customer`, the widget counts
  the rows it draws. They agreed on mock. If they ever disagree on real data
  that is a `service_summary` bug worth reporting to the Architect, not
  something to paper over on the client.

- **No test covers the scroll itself**, only that the handler targets the right
  column id and leaves the chip alone; `scrollIntoView` is browser behaviour.
  It was exercised by hand in Chrome (scrollLeft moved 0 → 1461).
