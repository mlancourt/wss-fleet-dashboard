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

---

# D44 — Fleet utilization by dollars (2026-09-04)

Built from `Dollar-Utilization-Site-Spec.md` (below its cut line) against
`CLAUDE.md` v1.8. **Site-only, as the order says** — no snapshot, Worker or
event changes, and no `wrangler deploy`. `units[].acquisition_cost` was already
in the contract.

## What shipped

- **The landing utilization bar is now a two-bar card**, one header
  (`FLEET UTILIZATION`), one width.
  - **Units** — the D19 bar, untouched in math, bands, colors and label, now
    captioned so the two read as a pair.
  - **Dollars** — ON-RENT `acquisition_cost` ÷ rentable `acquisition_cost` over
    exactly D19's population (`status == "RENTAL"`, not RETIRED). Same bands,
    same words. Sub-line `$309,300 on rent of $563,700` — whole dollars,
    separators, tabular numerals, no cents and no "≈".
  - Units with no cost are skipped on **both** sides and footnoted
    `N unit(s) without a cost excluded`.
- **`metrics.js`** — `utilization(units)` returns
  `{ units: {onRent, total, pct, band, label, color},
     dollars: {…, excluded} }`.
- **Mock** — `mock-full` gains one rentable unit with `acquisition_cost: null`
  so the footnote path is exercised; `mock-empty` keeps every cost so the
  no-footnote path is too. The `fleet_totals` reducer is null-safe.
- `BUILD` stamp and SW cache bumped (v12 → v13).

## Tests

`npm test` — 102 checks green, also under `TZ=Pacific/Pago_Pago`. Eleven new:
dollar % on a mixed set, demo/loaner capital counted as not-on-rent, a missing
cost excluded from both sides and counted, every cost missing → `null` rather
than NaN, both bars sharing one band vocabulary across all eight edges, and the
order's live example (18/35 units = 51 %; $251,624 / $421,578 = 60 % Building).
Two render assertions cover the landing: two captioned bars in one card, the
sub-line's format, the band class sitting on the bar, and the footnote showing
on `full` and hiding on `empty`.

Browser-verified at 390×844: one card, one header, two equal-length bars
(434px each), captions left-aligned, percent + word right-aligned, no overflow,
no console exceptions.

## Decisions I made

1. **`utilization()` was reshaped rather than duplicated.** The order specifies
   `utilization(units)` returning `{units, dollars}`, but a function of that
   name already held the D19 math in a flat shape. Reshaping it keeps one
   entry point for "how utilized is the fleet"; the existing D19 assertions
   moved to `.units` with their intent unchanged, and `band()` is untouched.
   The alternative — a second function beside the first — would have left two
   near-identical population filters to drift apart.

2. **The band class moved from the card to each bar.** It used to sit on
   `.util` and tint the whole block. Two bars can legitimately land in
   different bands on one fleet, which is the entire point of the second bar,
   so each carries its own colour.

3. **Each side keeps `label` and `color`, not just `band`.** The order's stated
   shape lists `band`; the renderer needs the word and the colour too, and
   spreading `band()` into each side is how the existing code already did it.

4. **`total` replaces `denom`** in the returned shape, per the order's naming.

5. **The footnote counts units, not dollars** — "1 unit without a cost
   excluded". How much money is missing is unknowable, which is why the unit is
   excluded in the first place; claiming a dollar figure there would be a
   fiction.

6. **A non-finite cost (`NaN`, `Infinity`) is treated as missing, not as zero** —
   same reasoning as `null`. Asserted.

7. **One costless unit was added to `mock-full` only.** The exit criteria ask
   for the footnote to appear "on the variant that has a null cost", which
   implies one variant has none. Setting a property consumes no RNG, so the
   other mock values did not churn.

## Things worth flagging

**None blocking.**

- **On mock the two bars nearly agree (54 % vs 55 %)**, because
  `make-mock-data.js` draws every acquisition cost from one random range with
  no relation to category. A real fleet's riders cost several times a
  walk-behind, so on real data the bars should diverge much more — which is the
  feature's whole point. This is a property of the fixture, not of the maths;
  the assertions pin a deliberately skewed case (60 % dollars vs 51 % units) so
  the divergence is proven regardless. Making the mock's costs scale with
  category would demo better and would be more realistic, but it churns every
  mock money value and was outside this order — worth doing next time the mock
  is touched.

- **`acquisition_cost: null` is now present in a mock snapshot.** The contract
  in `CLAUDE.md` shows the field as `0` in its example, and the order tells the
  client to tolerate `null`/missing — so the two are consistent in spirit. If
  the engine can in fact never emit a null cost, the footnote is dead code that
  costs nothing; if it can, it is now handled. No contract change was made or
  is being asked for.

---

# D45 — Cost + book leave the site; utilization comes pre-computed (2026-09-04)

Built from `Cost-Privacy-Site-Spec.md` (below its cut line). **Site-only** — no
Worker, DNS, token or secret changes, and no `wrangler deploy`. The contract
change (schema 4) is the Architect's; this repo consumes it and keeps rendering
schema 3 until the engine switches over.

## What shipped

- **`units[]` no longer carries `acquisition_cost` or `book`**, and neither is
  read anywhere on the site. `ask` stays. The unit page's Money card is now Ask
  plus the rate card; nothing else on it moved.
- **`meta.fleet_totals`** is `{ units: N }`. **`meta.utilization`** carries the
  two percentages and an exclusion count — and no amounts.
- **`metrics.js` gained `utilizationFrom(snapshot)`**: the engine's numbers when
  `meta.utilization` is present, the existing `utilization(units)` computation
  when it isn't.
- **The `$X on rent of $Y` sub-line is gone.** The landing page now matches no
  `$…` figure at all. The units bar keeps its machine-count sub-line, and the
  `N unit(s) without a cost excluded` footnote is sourced from the engine.
- **Mock emits schema 4.** `mock-legacy.json` is rebuilt as an authentic
  schema-2 file (see decision 3).
- `BUILD` stamp and SW cache bumped (v13 → v14). README updated.

## Tests

`npm test` — 115 checks green, also under `TZ=Pacific/Pago_Pago`. Eleven new:
schema-4 values taken from `meta.utilization` untouched with no amount
appearing, the engine winning over stale unit costs, the schema-3 fallback
matching `utilization(units)` exactly, malformed/absent metadata degrading to
`—` rather than NaN, no dollar amount anywhere on the landing, Ask present and
Cost/Book absent across eight unit pages, a unit stripped of every money field
rendering clean, and the schema-2 fixture rendering through the fallback with
its costs still off the screen.

Browser-verified at 390×844 on both the schema-4 and schema-2 fixtures: two
bars, no dollar amount anywhere on the landing, the unit Money card reading
`Ask` plus rates, no console exceptions.

## Decisions I made

1. **The engine's `meta.utilization` wins even when `units[]` still carries
   costs.** A transitional snapshot could plausibly have both. Recomputing
   would let this page show a different number than the vault computed, for the
   same fleet, with no way to tell which is right. Asserted explicitly.

2. **The dollar bar has no sub-line at all, on either schema.** The order says
   to delete it because schema 4 has no amounts *and* because we don't want
   them shown on schema 3. So the deletion is unconditional rather than
   conditional on the schema — the bar is a percentage and nothing else. This
   leaves the card slightly asymmetric (the units bar keeps its count
   sub-line); at 390px the footnote sits where the second sub-line was and the
   card still balances.

3. **`mock-legacy.json` was rebuilt as a genuine schema-2 file rather than
   inheriting the strip.** It is generated by downgrading the full snapshot, so
   removing cost and book upstream silently removed them from it too — and an
   authentic pre-schema-4 snapshot has both. The downgrade now puts them back
   from the generator's ledger. That keeps the file honest (its stated job
   since D42) and makes it do double duty: it has no `meta.utilization`, so
   rendering it exercises the fallback end to end, and it still carries cost
   and book, so it proves the page *ignores* those fields rather than merely
   not being sent them. A stripped fixture could not have proved that.

4. **Costs live in a ledger returned beside the snapshot, never inside it.** The
   generator still needs costs to compute `meta.utilization` the way the engine
   does. `build()` now returns `{ snapshot, ledger }` rather than attaching the
   ledger to the object it serialises — there is no code path by which a cost
   can reach a published mock file, even by mistake. Verified: neither
   `acquisition_cost` nor `book` appears anywhere in `mock-full.json` or
   `mock-empty.json`.

5. **`fromMeta()` returns no `total` or `onRent` on the dollars side** — not
   even `null`. Schema 4 carries no dollar amounts, and a key that looks like
   an amount is an invitation for a future renderer to print one. A test
   asserts both are `undefined`.

6. **A malformed `meta.utilization` degrades to "—" rather than falling back to
   client computation.** If the engine sent something the page can't read, the
   honest answer is "no number", not a second number computed from data the
   snapshot may no longer carry.

7. **`utilization(units)` keeps its name and shape** as the schema-3 fallback,
   per the order. Its doc comment now says out loud that it only has costs to
   add up on a schema-3 snapshot.

## Things worth flagging

**None blocking.**

- **The repo's `CLAUDE.md` is still v1.8, not v1.9.** The order said to read
  v1.9 and the spec says the schema-4 change is "mirrored into `CLAUDE.md` by
  the Architect", but the copy in this repo (HEAD `7ed75e8`, "synced from the
  vault master") still documents schema 3, `fleet_totals` with cost/book/ask,
  and `units[].acquisition_cost` / `book`. I built to the spec's §1, which
  states the change explicitly, and did not edit `CLAUDE.md` — it is the
  Architect's file and syncing it is not mine to do. **`CLAUDE.md` lines 120,
  127 and 128 now describe fields this site no longer receives or reads**, and
  should be synced before the next order is written against it.

- **D12 is now partly obsolete.** `CLAUDE.md` still says everyone "reads
  everything including cost/book/ask". After this order nobody reads cost or
  book, because they no longer exist in the snapshot. This is a *privacy by
  contract* change rather than a role change: there is still no per-role
  hiding on this site, and this order did not add any. Worth stating in v1.9 so
  a future session doesn't reintroduce a cost display on D12's authority.

- **The two bars still nearly agree on mock (54 % vs 55 %)** for the reason
  given in the D44 notes — the generator draws every cost from one flat random
  range. Unchanged by this order, and now less visible since the amounts are
  gone. The skewed case stays pinned in `selftest-metrics.mjs`.

- **`mock-legacy.json` deletion is now more load-bearing than it was.** The
  README already says to delete it after the cutover; note that doing so also
  removes the only fixture exercising the schema-3 utilization fallback. Delete
  the fallback and its unit tests at the same time, or keep the fixture until
  both go.

---

# D46 — Undo a pending event · Dispatch ordering · dollar-bar caption (2026-09-04)

Built from `Undo-Pending-Site-Spec.md` (below its cut line) against `CLAUDE.md`
v2.0 (schema 4). Items 1–2 are site-only; item 3 adds one Worker endpoint,
written and tested against `wrangler dev` but **not deployed** — the Architect
deploys after this push. No DNS, token or secret was touched.

## What shipped

**1. Dollar-bar caption.** The Dollars utilization bar carries the muted
caption `Fleet value on rent` in the same sub-line slot the Units bar uses for
its count. No number of its own, so D45's rule that no amount appears on this
site still holds. The excluded-units footnote sits under it.

**2. Dispatch leads with deliveries.** `sortByKind()` layers a kind rank over
the existing rule in Open and inside each Scheduled date group. Within a kind
nothing changed — dated ascending, undated last, then id — which comes free
because `Array#sort` is stable. Day groups are still built from the date-sorted
list, so the headings are untouched and only rows inside them reorder. "Done
this week" is a log rather than a queue and keeps its date order.

**3. Undo a pending tap.**
- **Worker:** `DELETE /api/event/<id>`, token auth. 404 when the key is gone or
  never existed, 403 when the stored `actor` is not the caller, otherwise it
  deletes exactly that one key and returns `{ok, id}`. It never touches
  `snapshot` and never bulk-deletes. CORS now advertises DELETE.
- **Page:** an Undo control on every individually-badged pending event, only
  when it is yours. Tap → inline confirm → DELETE → badge removed and `pending`
  re-read from `/api/data`. 404 reads "Already applied — change it with a new
  tap"; 403 reads "Not yours to undo".
- `api.js` gained `deleteEvent(id)`, which throws with `.status` set so 403 and
  404 can be told apart — they mean very different things to whoever tapped.

`BUILD` stamp and SW cache bumped (v14 → v15). README documents the endpoint
and its refusals.

## Tests

`npm test` — 121 checks green, also under `TZ=Pacific/Pago_Pago`.
`npm run m1` — **76 passed, 0 failed** against `wrangler dev`, including the
undo cases: no token → 401, unknown token → 401, someone else's → 403, **owner
override → 403**, the event surviving every refusal, own → 200, the inbox
losing exactly that key, a second undo → 404, an unknown id → 404, a malformed
id → 400, `snapshot` untouched, GET on the id path → 405.

Browser-checked at 390×844: the caption under the dollar bar with the footnote
beneath it, Open leading with a delivery dated four days *later* than the
pick-ups under it, the confirm sheet's exact copy, and per-role Undo counts
(Matt 1 on Dispatch / 0 on Service, Kevin 1 / 0, Josh 0 / 1) with all pending
badges still drawn for everyone. No console exceptions.

## Decisions I made

1. **Aggregate badges get no Undo.** The ⏳ count chip on a unit row, the
   kanban card's ⏳ glyph and the header total each stand for several events at
   once, so there is no single id to address. The control goes only where an
   individual event is named: the unit's pending block, a hold's pending
   release, a ticket's pending changes, a dispatch row, the pending "new run"
   notice, and the synthetic NEW ticket card. That is the spec's list plus the
   dispatch-add notice, which badges events the same way.

2. **The confirm is an inline panel, not a modal.** Every other sheet in this
   app (claim, done, add-a-run, stage) is inline, and a modal would be the only
   one. The button is replaced in place by the question and two buttons.

3. **On 404 the local badge is dropped as well as the message shown.** The
   event genuinely is gone; leaving the badge up while saying "already applied"
   would contradict itself. Both paths then `refresh()`.

4. **Mock identity became a real person per role** — owner Matt, sales Kevin,
   service Josh. "Is this mine?" is unanswerable while every mock user is
   called "Mock User", so the feature could not be reviewed or tested on mock
   at all. This also narrows the mock driver picker the way a real token does,
   closing a mock-only wart flagged in the D43 notes.

5. **`mock-pending` keeps an event by Zac, who is nobody's mock identity.** It
   makes the tests prove the control is per-ACTOR rather than per-role — a role
   check would have handed Zac's tap to Josh, who shares his role. That is the
   bug this fixture exists to catch.

6. **The id shape is validated before the KV lookup.** KV keys are flat strings,
   so `evt:../../snapshot` was never a traversal and would simply have missed;
   rejecting the shape with a 400 is clearer than a 404 that implies the id was
   merely stale. Real ids are `<utc-iso>:<rand6>`, so the character class is
   digits, letters, `:` `.` `-` `_`.

7. **The variable-segment path is matched ahead of the exact-path table** rather
   than teaching every row of `ROUTES` about patterns. One route needs it.

8. **An event with no `id` is never undoable** — `canUndo` requires one, so a
   badge can't offer a control it cannot address. Asserted.

## Things worth flagging

**None blocking.**

- **`owner` deliberately has no override, and the m1 loop asserts the refusal.**
  The spec is explicit and I agree with it, but it is worth Matt knowing
  plainly: he cannot undo Kevin's or Josh's pending tap from his own phone. The
  ways to change a colleague's unapplied write are to ask them to undo it or to
  make a superseding tap of your own. If that ever feels wrong in practice it is
  a spec change, not a bug.

- **Fixed a stale assertion in `m1-loop.sh` from D45:** it still required the
  published mock snapshot to be `schema_version: 3`. It had been failing since
  the mock moved to schema 4 and was only caught now because this order runs
  the loop. Worth noting that `npm run m1` is not part of `npm test`, so nothing
  else would have caught it.

- **Undo is a genuinely new kind of action for this site.** Everything else the
  crew taps is a proposal that the engine decides on. This one reaches into KV
  and removes a proposal before the engine ever sees it — no event records that
  it happened, so an undone tap leaves no trace anywhere. That is exactly what
  the order asks for ("an undone event simply never reaches the engine"), and
  it is the right shape for a wrong-button valve. Flagging it only so the
  absence of an audit trail is a known property rather than a surprise.

- **The two utilization bars still nearly agree on mock**, for the reason in the
  D44/D45 notes. Unchanged here.

---

# Schema 5 — Leads tab · three lead actions · the Worker money gate (2026-09-04)

Built from `docs-specs/Leads-Site-Spec.md` against `CLAUDE.md` v2.1, which
already carried the Architect's schema-5 pointer. Site + Worker; the engine was
already publishing schema 5 when I started, so the real snapshot was the
fixture. No DNS, token or secret was touched.

## What shipped

**1. `docs/leads.js` — a new pure module.** Enums and shop-floor labels, the
runtime option lists (`optionsFrom` prefers what `leads_summary` ships so a new
source needs no deploy), column building, the three chips, the stage picker's
gating, and the small `NO_DATA` / `pctOr` / `statOr` helpers that turn the
engine's nulls into the words the spec names. No DOM, no network, no
`Date`-parsing of date-only strings.

**2. Leads tab (`#/leads`), sixth in the nav.** Nav badge =
`leads_summary.received_uncontacted`, hidden at zero.

- **Scoreboard** — five rows in the spec's order, collapsible, open by default
  on `sales` and folded on everyone else. On the table · This month (three
  figures, each with an ↑/↓/— against the engine's three-month baseline) ·
  Speed (median hours to first contact, `n=`, 🔥 at a streak of 3) · Conversion
  (two rates plus the median days to win; `insufficient` collapses the whole
  row to "not enough data yet (n=…/5)") · Stale, which is itself a button that
  applies the Stale chip.
- **Insights** — "Pipeline insights — last 90 days", collapsed, `owner` +
  `sales` only, six small tables. No charts (v1).
- **+ New lead** — any role, nine taps: customer · contact · phone/email ·
  source chips · interest chips · machine (type it **or** pick one of ours) ·
  site · priority · assignee · next action · note.
- **Board** — five columns: the four open stages, then **Won** (a *status*
  column). LOST/DEAD sit in a collapsed Closed strip. Chips All · Mine · Stale,
  remembered per device like the Service chip.
- **Lead detail** — every field in three cards (Who · The deal · Timing), the
  stage picker (INVOICED hidden unless `owner`), note / value / next action /
  assign / priority sheets, and Close → LOST (reason chips) or DEAD.

**3. Three write actions.** `lead_open` (any role) · `lead_update`
(`sales`/`owner` full, `service` **note only** — any other key is a 403) ·
`lead_close` (`sales`/`owner`). `force` is accepted only from `owner`.

**4. The money gate (§6, L4).** `GET /api/data` parses and strips the snapshot
**at the edge** for a `service` token: `value` + `potential_commission` off
every lead, `leads_summary.commission_rates`, `leads_summary.money_fields` and
`scoreboard.money`. `insights` ships as-is. It fails **closed** — a snapshot
that will not parse gets a 500, never a fall-through to the raw text.

**5. §4 tie-in.** A DEMO hold on a unit page carries a `demo` chip and links to
the lead whose `demo.hold_id` matches — matched on the id and nothing else.

`BUILD` stamp and SW cache bumped (v15 → v16); `leads.js` added to the shell
cache. Header reads v2.1.

## Tests

`npm test` — **56 render checks + 25 leads checks**, green, also under
`TZ=Pacific/Pago_Pago`.

`npm run m1` — **105 passed, 0 failed** against `wrangler dev`, including all
three lead actions, the twelve refusals (service closing/staging/pricing a
lead, bad source, bad interest, no customer, a value as a string, a negative
value, an empty update, a traversal-shaped lead id, `outcome: WON`, a bogus
lost reason), and the money gate: the literal `grep -q potential_commission`
the spec names, plus `commission_rates`, plus per-role assertions that `sales`
and `owner` keep everything.

`node tools/smoke-real.mjs ~/.wss-runs/real-snapshot-schema5.json` — **12
passed, 0 failed**: 74 pages per role, all three roles, no thrown view and no
leaked `undefined`.

The money gate was also run against the **real** snapshot published to a local
`wrangler dev`: a service token's `/api/data` contained neither string, kept 36
units / 17 tickets / `insights`, and `sales` kept the money. The local KV was
then overwritten with the mock; nothing real was written into the repo.

Browser-checked at 390×844: six tabs still fit, the scoreboard open for Kevin
and folded for Josh, the Stale row filtering the board, the demo hold's link
from a unit page, and the Closed strip.

## Decisions I made

1. **`hasMoney()` reads `scoreboard.money`, one signal for the whole page.**
   Deciding per field would let the cards and the scoreboard disagree about
   what is visible. Presence, not truthiness — `$0` on the table is a fact and
   has to stay on screen.

2. **A missing money field draws NOTHING — no `—`, no `$0`, no greyed box.**
   A placeholder tells the reader exactly where the number they can't see
   lives, which is most of the disclosure. `selftest-render.mjs` asserts there
   is not a single dollar figure above the board for a stripped payload.

3. **`leads_summary.money_fields` is stripped too, though §6 doesn't list it.**
   It contains the literal string `potential_commission`, so the curl check the
   spec mandates could never pass while it shipped. It is a Worker directive, so
   a service client loses nothing.

4. **The strip is the union of `money_fields` and our own copy of the list.** A
   malformed or missing `money_fields` must not open the gate. It only ever
   widens what is removed.

5. **Won is a status column, not a stage column.** An OPEN lead parked at a
   stage the board has no column for (INVOICED, or one the engine invents
   later) gets its own column inserted before Won — the same rule
   `columnize()` uses for tickets. Hiding a column is a display choice;
   dropping a lead is data loss.

6. **A win is not closed with `lead_close`.** `lead_close` takes LOST or DEAD
   only; a win is reached by moving the stage to INVOICED, which names a real
   invoice. That is why INVOICED is `owner`-only in the picker.

7. **Three stage moves ask for something first** (`stageNeeds`): DEMO-SCHEDULED
   wants a day and a unit, INVOICED wants the invoice number, QUOTED wants a
   value **only if we don't already have one**. Zero counts as having one —
   asking again would overwrite a deliberate zero.

8. **`service` gets a 403 on a lead_update carrying anything but a note**,
   rather than the key being dropped. A silently ignored write is worse than a
   refusal: the tech would believe they had changed something.

9. **`force` is dropped for non-owners rather than refused.** The safe reading
   of an unexpected `force` is "leave the duplicate check switched on", and the
   UI never offers it — it is there for a future admin path.

10. **`quote.file` is scheme-checked before it becomes an href.** Escaping keeps
    the URL inside the attribute; it does not make `javascript:` safe. Only
    `http(s)` draws a link, and anything else draws no link at all.

11. **A DEAD close sends `reason: null`,** even though the LOST reason chips are
    still in the form with a value. Sending the hidden chip's value would put a
    "why" on a lead nobody chose one for.

12. **`tools/smoke-real.mjs` reads a real snapshot by PATH and serves it from
    memory.** Nothing is copied into `docs/`. The tool itself holds no data,
    which is why it can live in the repo — and the schema-5 bump is exactly the
    case where the mock generator only produces what we thought to write.

13. **The mock's `scoreboard` and `insights` are DERIVED from its own
    `leads[]`,** not hand-typed. A reader can count the cards and get the same
    totals, so a mis-render is visible rather than plausible. The fixture is
    tuned to five closed leads in the window — one over `min_n` — so the full
    variant exercises the populated path and the empty variant the
    "not enough data" one.

## Things worth flagging

- **`NEEDS-QUOTE` arrived in `CLAUDE.md`'s service-stage enum while I was
  working, and is NOT implemented.** The service_queue stage list in the
  contract now reads RECEIVED · CONTACTED · **NEEDS-QUOTE** ·
  WAITING-ON-CUSTOMER · … but `worker.js`'s `STAGES` set and `docs/service.js`'s
  `STAGES` array still hold the eight from D42. Consequences today: a
  `ticket_update` moving a ticket to `NEEDS-QUOTE` is **rejected with a 400**,
  and a ticket the engine parks there renders in a trailing extra column rather
  than in pipeline order. Nothing is dropped — `columnize()` keeps it — but the
  stage is not usable from the site. This was outside the Leads work order and
  adding a stage is an Ask-Matt item, so it needs its own order from the
  Architect. It is a two-line change in each file plus a label and a pipeline
  colour.

- **The real snapshot has zero leads.** Every Leads assertion against real data
  is therefore an empty-state assertion. The populated paths — the board, the
  cards, the money line, the insights tables — are proven on mock only until
  Kevin writes the first lead down. Re-run `smoke-real.mjs` once there are a
  few.

- **The scoreboard's collapse state is per session, not per device.** The
  Service and Leads *chips* are remembered in `localStorage`; the scoreboard
  fold is deliberately not, because its default is role-derived and a
  remembered "collapsed" would quietly override that for Kevin forever. Easy to
  change if he asks.

- **`insights` is not money-gated and that is deliberate** (§6 says so
  explicitly: `won_value` is deal size, not commission). It does mean a service
  token can read median won/lost deal values from the "why we lose" caption. If
  that is not intended, it is a contract question for the Architect, not a CSS
  one.

- **Six tabs is the ceiling.** At 390px each tab is ~65px; the labels tighten
  to 10px under 430px. A seventh would need a different nav — an overflow
  sheet, or dropping Holds into Fleet.

---

# D47 — `NEEDS-QUOTE` service stage (2026-09-04)

Built from `docs-specs/Needs-Quote-Site-Spec.md`. Three touches, additive, no
tag. The engine was already enforcing the stage; this makes the site and the
Worker able to speak it.

## What shipped

**1. Worker.** `NEEDS-QUOTE` added to the `ticket_update.stage` enum — nine
values now. Role gating unchanged (a stage move is still `service` + `owner`).
Membership only, as everywhere else in that file: a `NEEDS-QUOTE` on a
WSS-owned ticket is **accepted** by the Worker and refused by the vault, which
is where "nobody quotes us to us" belongs.

**2. Service tab.** `docs/service.js` `STAGES` gained `NEEDS-QUOTE` between
`CONTACTED` and `WAITING-ON-CUSTOMER`, and the WSS skip set went from two
stages to three. Everything downstream follows from those two edits, because
the kanban columns, the stage picker and the pipeline rows are all derived from
`stagesFor()` / `STAGES` rather than listed separately:

- kanban: nine columns under All and Customer, still **six** under Fleet;
- stage picker: offered on a customer ticket, absent on one of ours;
- pipeline widget: an eighth row, **"Needs quote"**, straight after Contacted,
  in the same maroon as RECEIVED (`pipe-new`) — our court, deliberately not the
  amber of WAITING-ON-CUSTOMER. No new CSS was needed for the colour.

**3. Mock.** Two customer-owned `NEEDS-QUOTE` tickets (S1011 Birchwood Cold
Storage, S1012 Stillman Foundry), so the new column is never one deep, and the
nine-key `service_summary.open_by_stage` rollup.

`BUILD` stamp and SW cache bumped (v16 → v17).

## Tests

`npm test` — **57 render + 31 service checks**, green, also under
`TZ=Pacific/Pago_Pago`. New assertions: the stage's position in the list, that
`canStage` allows it for service/owner and refuses it for sales and on a WSS
ticket, that Fleet stays at six columns while All goes to nine, that the
pipeline row is maroon and matches RECEIVED rather than WAITING-ON-CUSTOMER,
and — at render level — that a fleet ticket's picker draws six buttons with no
NEEDS-QUOTE among them.

`npm run m1` — **110 passed, 0 failed** against `wrangler dev`: service moves a
customer ticket to NEEDS-QUOTE, owner may too, sales gets a 403, an invented
stage gets a 400, and the WSS case is asserted to **pass the Worker** so the
division of labour is pinned in the test rather than assumed.

`node tools/smoke-real.mjs` — 12 passed against the real schema-5 snapshot,
which has no NEEDS-QUOTE tickets yet.

## Decisions I made

1. **`stagesFor()` now reads from a `WSS_SKIP` set** rather than a chain of
   `!==`. Three exclusions is where the chain stops being readable, and it is
   the single place the skip list lives — the picker, the kanban columns and
   the Fleet count all derive from it.

2. **`NEEDS-QUOTE` reuses `pipe-new` (maroon) rather than getting a colour of
   its own.** The spec asks for maroon and gives the reason: it is WSS's court,
   the same family as RECEIVED. Two maroon rows on the widget is the intended
   reading — "these are waiting on us" — not a collision.

3. **The kanban's desktop column floor is new.** Nine columns sharing 1040px
   would be ~100px each, narrow enough to ellipsise every customer name, so
   `.kan-col` gained `min-width: 150px` inside the wide-screen rule. Below the
   floor the board scrolls sideways, which is what it already does on a phone.
   All nine sit side by side from about 1500px.

4. **The M1 loop asserts the WSS case is a 201, not a 400.** It looks like a
   missing validation until you read why: the Worker checks shape and role, the
   vault checks business state. Writing that down as a passing test is the only
   way the next session doesn't "fix" it.

## Things worth flagging

- **`CLAUDE.md`'s prose is now behind its own enum.** The Architect's sync added
  `NEEDS-QUOTE` to the `service_queue.stage` line, but §4 of the UI spec still
  reads "eight columns by `stage` (six under the Fleet chip — WAITING-ON-CUSTOMER
  + READY-TO-INVOICE never apply)", `service_summary` still says "…all eight
  stages…", and the v1.7 / v1.8 lines still list the eight and describe the
  pipeline as "seven stage rows". The code is right and matches the spec; the
  brief needs a vault-side pass. I did not edit it — it is synced from the vault
  master.

- **No real ticket is in NEEDS-QUOTE yet**, so every real-data check of this
  stage is an absence. Worth a second `smoke-real.mjs` run once Josh has moved
  one.

---

# v2.4 — Notes timeline on tickets and leads (2026-09-04)

`service_queue[].log[]` and `leads[].log[]` rendered as a **Notes** timeline in
ticket detail and lead detail. Additive, no tag. One thing did not go to plan —
see the money-gate note below, which is the item to read first.

## What shipped

**1. `docs/notes.js` — a new pure module.** `logRows(entity)` and
`pendingNotes(events)`, shared by tickets and leads because the row shape is
identical. It exists mostly to hold one rule down in writing: `ts` is a display
string the engine has ALREADY formatted for a Central reader, in one of two
shapes — `"2026-09-04 11:09 CT"` on a stamped row, a bare `"2026-09-03"` on an
imported one. It is neither an instant to format nor a business date to
reformat. It renders verbatim and never goes near `new Date()`. The order is the
engine's too: oldest first, never re-sorted — sorting those two shapes against
each other would quietly separate a tech's answer from the import note it
answers.

**2. The timeline.** In both detail views, immediately above the stage picker —
you read the notes, then you move the thing. Text is the primary line (Matt
prices a job off Josh's diagnosis, which is the whole reason the field exists),
with `who` as a small chip when the engine parsed one and the timestamp beside
it. About a third of real rows have `who: null`; those keep their row and simply
draw no chip. Empty or absent logs render "No notes yet." rather than a gap.

**3. Pending notes above the record.** A note typed this session renders in a
tinted row above the log, badged "⏳ applies at the next run".

**4. Mock.** Three tickets and two leads carry logs — including an authorless
import row, a bare-date `ts`, and a four-row NEEDS-QUOTE diagnosis that is the
exact case the field exists for. Nine tickets and twelve leads keep an empty
log so the empty state is exercised.

`BUILD` stamp and SW cache bumped (v17 → v18); `notes.js` added to the shell.

## The money gate had to widen — read this one

The render suite caught it: the engine writes money INTO the lead log. Real
rows read

    <name> | <name> value → $<amount>
    <name> | <name> value → $<amount>

So rendering `leads[].log` would have handed a `service` token the exact figure
`stripLeadMoney()` deletes from `leads[].value` — in the same response, in plain
text, one field over. That is not a rendering detail; it is the §6 gate being
undone by a feature added after §6 was written.

**The Worker now deletes `leads[].log` for a `service` token**, alongside the
money fields. `service_queue[].log` is untouched.

This is a deliberate **over-strip** and I want it flagged rather than absorbed:

- §6 does not list `log` — §6 predates the field, so this is me extending a
  mandated control rather than implementing one. Ask-Matt territory.
- It has a real cost. `service` may add a note to a lead (`lead_update`,
  note-only), and they now cannot read the log those notes land in. Their own
  *pending* note still shows — that comes from the `pending` array, not the
  snapshot — but it vanishes from their view at the next run.
- The better fix is upstream: a **redacted** lead log for service tokens, or
  the engine writing value-change rows in a form that carries no figure. Either
  would let a tech keep their notes.
- If the Architect decides the value is fine for a tech to see, this is one
  `delete` to remove in `worker.js` plus three assertions.

I took the fail-closed option because the two failure modes are not
symmetrical: over-stripping is visible to Josh in a day and reversible in a
minute, while under-stripping is invisible and cannot be un-seen. It is also
what D45's "privacy by contract, not by CSS" points at — the control belongs at
the edge, not in a regex over free text, which is where a "redact anything that
looks like money" approach would have ended up.

## Tests

`npm test` — **63 render + 8 notes checks**, green, also under
`TZ=Pacific/Pago_Pago`. The render checks pin: every row on screen in the
engine's order; a chip per authored row and none for the imports; both `ts`
shapes verbatim with no `Invalid Date`/`GMT`/`T00:00:00` anywhere; the pending
note above the record; the empty state; a schema-2 snapshot with no `log` field
at all; and the gate — no lead-log rows for a tech, both kept for Kevin, ticket
logs kept for everyone.

`npm run m1` — **112 passed, 0 failed** against `wrangler dev`, including
`leads[].log` absent for `service`, ticket logs present for `service`, and both
present for `sales`.

`node tools/smoke-real.mjs ~/.wss-runs/real-snapshot-schema5.json` — **19
passed, 0 failed**. It now asserts the timeline against real rows rather than
just "didn't throw": all 17 tickets carry a log, S1013's nine rows all render,
every real timestamp renders verbatim in both shapes, `who` is a chip on five of
nine rows and absent on the other four, and **S1014 shows Josh's diagnosis in
full, attributed to Josh** — the case the order named.

The gate was also run against the real snapshot published to a local
`wrangler dev`: a service token's bytes contain neither `potential_commission`
nor either lead value in the log text, all 17 ticket logs survive, and `sales` keeps both
lead logs. Local KV was restored to the mock afterwards.

## Decisions I made

1. **Notes sit immediately above the stage picker** in both views. You read the
   diagnosis, then you move the stage or quote it — the two actions are
   adjacent on purpose.

2. **Pending notes render above the log, not at the end of it.** This is what
   the order asked for, and it is defensible: the log is what the vault holds,
   and a proposal that hasn't been applied has no place in that chronology.
   It does read slightly oddly — the note you just typed appears above thirty
   older ones. If you meant them at the bottom (temporally correct, since they
   are the newest thing) it is a one-line move in `notesSection()`.

3. **A row with no `text` is dropped; a row with no `who` is kept.** An empty
   bubble with a timestamp says nothing; an authorless row is a third of the
   real history.

4. **`white-space: pre-wrap` on the text.** The real rows carry the shop's own
   double-spacing between sentences and it reads better kept than collapsed.
   Paired with `overflow-wrap: anywhere` so a long token can't push the card
   sideways.

5. **A 30-row cap in the client too**, keeping the RECENT end. The engine
   already trims to 30; if a longer log ever arrives, the newest half is the
   half worth having on a phone.

## Things worth flagging

- **The lead-log strip needs the Architect's ruling** — see above. It is the
  only thing in this build I would call provisional.

- **Pending notes are not money-gated**, and cannot be: they come from the
  `pending` array, which is the crew's own unapplied proposals rather than the
  snapshot. If somebody types a dollar figure into a lead note it is visible to
  everyone until the next run drains it. Probably fine — it is their own tap —
  but it is the one remaining path by which a number reaches a `service` token.

- **`ts` is not machine-readable and nothing should start treating it as such.**
  There is no sort, no filter and no "notes since" feature that can be built on
  this field as shipped. If one is wanted, it needs a real instant from the
  engine alongside the display string.

---

# v2.5 — lead logs money-free by contract; the strip reversed (2026-09-04)

The Architect's ruling on yesterday's flag: right call, fix it upstream. The
engine now never writes a dollar figure into a lead log row (`value set` /
`value updated`), and its builder refuses to publish a lead log containing one.
So the v2.4 fail-closed strip comes out and Josh gets his lead notes back.

## What shipped

**1. The strip is reversed.** One `delete lead.log` removed from
`stripLeadMoney()`. The comment in its place says why the field is deliberately
NOT stripped and where the guarantee now lives, so the next session doesn't
"restore" it on sight.

**2. A Worker test that holds the promise to account.** `tools/money-gate.mjs`
(`npm run money-gate -- <snapshot>`) publishes a real snapshot to a running
Worker, reads `/api/data` as all three roles, asserts the whole §6 gate —
including that **no lead-log row matches `/\$\s?\d/`** — and restores the mock
snapshot in a `finally`, so no real data is left in the KV it touched. It reads
the file by path and writes nothing to disk, same rule as `smoke-real.mjs`.

Against the refreshed real snapshot: **16 passed, 0 failed**, 9 lead-log rows
checked, 83 ticket-log rows untouched.

It is not a vacuous guard. Poisoning a copy of the real snapshot with the exact
row v2.5 outlawed makes it fail, name the offending lead and row, and print
"Fix it upstream — do NOT re-add a strip or a redaction here."

**3. The same assertion in `npm run m1`, against mock**, so a regression is
caught by the routine loop without needing real data. The mock's one
value-change row was changed from a figure to `Kevin value set` to match the
engine's new contract — otherwise the guard would have been testing nothing.

**4. Pending notes moved below the log, newest last.** They ARE the newest thing
on the timeline; the tint and the ⏳ badge carry "not applied yet", and the
position now carries "most recent", which is true. The CSS adjacency rule
flipped with it.

`BUILD` stamp and SW cache bumped (v18 → v19).

## The assertion I got wrong, and what it taught

I first wrote a belt-and-braces check: *no dollar figure anywhere under
`leads[]`, in any field.* The mock failed it immediately, on two honest rows:

    machine:    'Used 32" rider under $18k'
    close_note: 'Came in $2,400 under us on a private sale'

A customer's stated budget and a competitor's price. Neither is our deal value
and neither is anybody's commission — they are sentences a person typed into a
free-text field, and no contract can promise they are figure-free without
banning people from writing down what a customer said.

So the check is gone, and both files now carry a comment saying it is
deliberately absent and why. This is the boundary worth knowing: **the gate
covers the structured money and the log rows the ENGINE writes. A sentence
somebody typed is theirs.** An assertion that claimed more would have failed on
honest data and been muted within a week, which is worse than not having it.

## Tests

`npm test` — **64 render + 8 notes checks**, green under
`TZ=Pacific/Pago_Pago` too. Three assertions flipped: the stripped-service
helper no longer deletes `log`; a service token is asserted to KEEP the lead log
and to see `Kevin value set` in it; and the pending note is asserted to sit
*below* the last log row. One added: no lead-log row in the fixture carries a
figure.

`npm run m1` — **113 passed, 0 failed**.

`npm run money-gate -- ~/.wss-runs/real-snapshot-schema5.json` — **16 passed, 0
failed**, plus the poisoned-fixture negative above.

`node tools/smoke-real.mjs …` — **19 passed, 0 failed** on the refreshed
snapshot; S1014 still shows Josh's diagnosis in full, attributed.

## Things worth flagging

- **`npm run money-gate` needs a running Worker and a real snapshot**, so it is
  not in `npm test` and never will be. It belongs in the deploy loop next to
  `npm run m1`. The README says so.

- **Pending notes are still not money-gated** — unchanged from v2.4, and
  unchangeable: they come from the `pending` array, which is the crew's own
  unapplied proposals rather than the snapshot. If somebody types a figure into
  a lead note it is visible until the next run drains it. It is their own tap,
  and the engine's builder will catch it on the way into the log.

- **The real snapshot refreshed twice while I worked** (2 leads, then 4). Both
  were money-free. Nothing in the tests depends on a particular run id or lead
  count, which is why both runs passed unchanged.

---

# Schema 6 — document attachments, S1 read path (2026-09-08)

Built from the S1 work order against `CLAUDE.md` v2.6. **Five Worker endpoints
and one site element.** No new write action, no new binding, no new namespace.
Tested on mock + a synthetic PDF through `wrangler dev`. **Not deployed** — the
Architect deploys.

## What shipped

**Worker** (`worker/worker.js`, still one file):

| Route | Auth | Behaviour |
|---|---|---|
| `GET /api/doc/<id>` | token — `?t=` **or** Bearer | streams the bytes out of KV; `Content-Type` from the stored meta, `Content-Disposition: inline`, `Cache-Control: private, max-age=31536000, immutable`, `X-Content-Type-Options: nosniff` |
| `PUT /api/admin/doc/<id>` | secret | `201 {id, bytes}` · `200 {id, existed:true}` · `409 {error:"hash mismatch", expected}` · `415` · `413` (10 MB) · `400` |
| `GET /api/admin/doc/<id>` | secret | the same bytes, for the engine's down-leg |
| `DELETE /api/admin/doc/<id>` | secret | `200 {id, deleted:true}` / `404` |
| `GET /api/admin/docs` | secret | `{count, docs:[…]}` by `added_utc` ascending |

Two KV keys per doc — `doc:<id>` (raw ArrayBuffer, never base64) and
`docmeta:<id>` — meta written **last** and deleted **first**, so a half-write or
half-delete is invisible: the listing and every reader go through `docmeta:`.

**Site** — `docs/attachments.js` (new, pure) plus a `docsSection()` in `app.js`
rendered between the record card and the Notes timeline on **ticket detail and
lead detail**. One 44 px full-width row per doc: icon, `Kind — name`, humanized
size, chevron. A tap is `window.open(…?t=…, '_blank', 'noopener')` — a real new
tab, no iframe, no fetch-then-blob. Empty `docs[]` renders nothing at all.

`docs/sw.js` names `/api/doc/` in its bypass explicitly (cache bumped to v20).

## Decisions I made

- **`PM-REPORT` renders as "PM-Report" and `PO` as "PO", not "Pm-Report" /
  "Po".** The work order says "title-cased with the hyphen kept", and its own
  example (`Parts-List`) is what that rule is for. Applied literally it turns
  two initialisms — preventive maintenance, purchase order — into what reads on
  a shop floor as a typo. So: title-case as specified, with a two-entry
  initialism set. Flagged to the Architect; a one-line change if it's wrong.

- **Sizes are decimal, not binary.** 25 602 bytes is "26 KB" in the work
  order's own example, which is 1000-based — and it is what the phone's own file
  info will say beside it. One decimal below 10 ("1.9 MB" is worth knowing
  before you tap it on LTE), none above.

- **A doc row with a malformed `id` is dropped, not drawn.** The id *is* the
  content hash and the only part of the row that reaches a URL; a row that
  cannot produce a valid `/api/doc/<id>` could only ever open a 404, so it never
  becomes a tap target. Everything else falls back instead: no name → "document",
  no kind → OTHER + 📄, no `bytes` → no size chip (never "NaN KB").

- **`X-Doc-Name` refuses more than path separators.** It is echoed into a quoted
  `Content-Disposition` filename, so a `"` or a control character would be
  header injection rather than a name. Validated on write **and** sanitised on
  read, so a doc cached before any future validation change still produces a
  header nobody can break out of.

- **`Content-Length` is deliberately not set on the doc GET.** The value is
  streamed from KV; a manually-set length that ever disagreed with the body
  would break the response outright, and the progress bar it would buy is not
  worth that.

- **Agreements carry `docs[]` in the mock but render nowhere.** There is no
  agreement detail sheet today (the work order says skip them), so the field
  exists for contract completeness and the Rentals list is untouched.

- **A `409` is returned rather than thrown.** `httpError` is for shape refusals;
  a hash mismatch has a body worth reading (`expected`), which is the whole
  point — the engine can correct its own index from the response.

## Tests

`npm test` — **70 render + 12 attachment checks**, all suites green. New:
Documents renders above Notes on both detail views; the row is a `<button>`
carrying only the 16-hex id (asserted that no `doc:` / `docmeta:` key can reach
the page); a `service` token sees a lead's QUOTE; an empty `docs[]` draws
nothing; **and a schema-5 snapshot with the `docs` key deleted everywhere
renders every ticket and every lead unchanged.**

`npm run m1` — **140 passed, 0 failed**, including the whole document section
against `test/fixtures/sample-quote.pdf` (24 557 bytes, synthetic): hash
mismatch → 409 with nothing stored, 201 then 200 `existed:true`, the listing,
`?t=` and Bearer reads with the headers asserted, 401/404/400/405, an 11 MB body
→ 413, `text/plain` → 415, DELETE → 404, and **the bytes read back hashing to
the same id**.

## Things worth flagging

- **Mock doc ids point at nothing.** They have the right shape but no bytes in
  any KV, because no document may live in this repo. Tapping one in mock mode
  says "Mock mode — documents live on the Worker" and stops. Against a real
  snapshot whose ids the engine has actually pushed, the same tap opens the file.

- **A `docs[]` id the engine never pushed is a 404 in the tech's face.** The
  Worker cannot tell "not cached yet" from "never existed" — it only has
  `docmeta:`. If that turns out to matter in the field, the fix is on the
  engine's side (publish the row only after the PUT returns), not here.

- **`POST /api/doc` (crew upload) is S2 and is not built.** There is a named
  stub comment where it goes, next to the crew read.

- **KV is eventually consistent (~60s cross-edge).** A doc PUT and the snapshot
  that references it can land on an edge out of order, which looks like a brief
  404 on a brand-new attachment. Same lag the README already documents for the
  snapshot; not a new class of problem.

---

# Schema 6 / S2 — document upload from the phone (2026-09-08)

Built from the S2 work order against `CLAUDE.md` v2.6 + the S1 code. **One
Worker endpoint, one write action (the tenth core one, approved 2026-09-08),
two buttons.** Tested on mock + `wrangler dev`. **Not deployed.**

## What shipped

**Worker** — `POST /api/doc` (token, any role). Body = raw bytes; headers
`Content-Type`, `X-Doc-Name`, `X-Doc-Record` (`^[SL]\d{4}$`), `X-Doc-Kind`
(`WORKORDER · PARTS-LIST · PHOTO · OTHER` — a phone may not mint the vault's
kinds). The client sends **no id**: the Worker hashes the body and that is the
id, so there is no hash-mismatch case on this door and a double tap is one
document. `docmeta` gains `record` + `kind`, `source: "crew"`, `actor` = token
name. `201 {id, bytes, existed:false}` / `200 {id, existed:true}`.

The admin PUT and the crew POST now share `readDocBody()` (type → declared
length → real length) and `storeDoc()` (bytes first, meta last), so "what counts
as a document" cannot drift between the two doors.

**`doc_attach`** — tenth core action, `ALL_ROLES`. `{record, doc_id, kind,
name}`, `serial` unused. It is **the only action in the Worker that checks
business state**: 400 when `docmeta:<doc_id>` is absent. That check is in
`crewEvent`, not `cleanPayload`, because `cleanPayload` is sync and has no
`env` — and keeping it there also keeps the shape-only rule visible in the
place it still holds.

**Site** — 📷 Photo (`capture="environment"`) and 📎 File in the Documents group
on ticket and lead detail, any role. A pick opens a kind sheet (Work order
default · Parts list · Other) with the filename and a thumbnail; one tap sends.
The group now has three tiers: filed (snapshot) → pending `doc_attach` → unsent
(sending / failed). New pure helpers in `docs/attachments.js`
(`resolveKind`, `sanitizeName`, `retypeName`, `cameraName`, `pendingDocRows`),
the canvas work in `app.js`, `uploadDoc()` in `api.js`.

## Decisions I made

- **"Other" resolves to PHOTO from the FILE TYPE, not from which button opened
  the picker.** The work order gives two examples — 📷 + Other → PHOTO, PDF +
  Other → OTHER — and they confound source with type. Keying on type satisfies
  both exactly (a camera capture is always an image) and also gets the case they
  do not name: a photo picked out of the Files app instead of shot on the spot,
  which the source rule would have filed as 📄 OTHER. One line in `resolveKind`
  if the Architect wants it keyed on source after all.

- **The heading in `CLAUDE.md` now says thirteen actions, not ten.** The work
  order says "nine → ten", which is right for the core set the heading was
  counting, but the heading was stale: schema 5 added three lead actions and
  never updated it. It now reads "thirteen — nine through schema 3, three lead
  actions at schema 5, `doc_attach` at schema 6", and the roles paragraph calls
  `doc_attach` "the tenth of the core set" so the Architect's own framing
  survives. Flagged rather than silently recounted.

- **An empty Documents group now draws on a detail view.** S1's rule was that an
  empty `docs[]` renders nothing at all. The add buttons live in this group, so
  on ticket/lead detail it always draws — an empty one is not a placeholder, it
  is the way to put a document on the record. No count chip and no "No
  documents" text, so nothing was added except the two doors. The S1 test was
  rewritten to assert exactly that, rather than deleted.

- **The kind sheet's file is held in a module-level `pendingPick`, not in `ui`.**
  `ui` is the transient view object and a `File` has no business in something we
  might one day serialise. Same reason `uploads` and `thumbs` are their own Maps.

- **`prepareFile` reads the File in the `change` handler before any render.**
  `render()` rewrites the view's `innerHTML`, which destroys the `<input>` and
  its `.files` list with it. Read it late and it is gone — an invisible bug on
  the desktop, every time on a phone.

- **EXIF is asked for three ways**: `createImageBitmap(file,
  {imageOrientation:'from-image'})`, then bare `createImageBitmap`, then an
  `<img>` (modern Safari applies EXIF to an `<img>` by default). Without the
  first, every portrait photo a tech takes lands on its side — and it would look
  correct in every desktop test.

- **A camera capture's filename uses LOCAL time** (`WO-S1018-20260908-1432.jpg`).
  Rule 7 governs timestamps in the data; this is a label a person in Ixonia
  reads, and a 2pm photo named "…-1900" would look wrong to the only people who
  will ever see it. Asserted, with the reasoning, in the test.

- **Filenames are sanitised client-side** (path separators, quotes, anything
  outside printable ASCII) before they become an `X-Doc-Name` header. Not
  belt-and-braces: a header value that is not Latin-1 makes `fetch()` throw
  before the request leaves, so a photo named with an accent would fail with no
  server response to translate into a message.

## Tests

`npm test` — **75 render + 22 attachment checks**. The five new render checks
drive the *real* handlers (a `change` from a fake file input, a `click` on a
kind button): a 4000×3000 capture resizes to 1600×1200 at q0.7 with the EXIF
option asserted and the **resized** blob — not the 9 MB original — going out; a
PDF reaches `fetch` as the very same `File` object with the canvas untouched; a
413 renders "Too big (max 10 MB)" and a retry re-sends from memory with no
second pick; a pending `doc_attach` lands on its own record and on no other.

Node has no canvas, so the stub records the canvas dimensions and the encoder
settings and returns bytes proportional to pixels. **The "under 1 MB" half of
the work order's test 5 is asserted as the mechanism that produces it —
1600 px long edge, `image/jpeg`, q0.7 — not as a fabricated byte count dressed
up as a measurement.**

`npm run m1` — **166 passed, 0 failed**, including the phone-shaped upload of
both fixtures (PDF and PNG), the `docmeta` record binding, `existed:true` on a
re-send, all six header refusals, and `doc_attach` accepted for all three roles
and refused for an unknown/malformed doc_id, a bad record and a vault-only kind.

## Things worth flagging

- **The S2 section of `m1-loop.sh` runs after the S1 section has emptied the
  store, deliberately.** Both use `sample-quote.pdf`, and the same bytes are the
  same document — uploading it as crew while the vault's copy was still there
  correctly answered `existed:true` and proved nothing about the crew path. The
  first run of this suite failed exactly that way; the fix was the ordering, not
  the code.

- **`source` on a re-sent doc is whoever got there first.** If the engine has
  already cached those exact bytes as `vault`, a crew POST of the same file
  returns `existed:true` and the meta keeps `source: "vault"` with no `record`.
  The `doc_attach` still fires and the engine still files it, so nothing is
  lost — but the sweep for unfiled crew docs will not see it. Only reachable
  when a tech uploads a byte-identical copy of something the vault already has.

- **No progress bar, only "Sending…".** `fetch` gives no upload progress without
  moving to XHR; at ~300 KB after the resize the send is short enough that a
  spinner would be all a tech ever saw.

- **A pending row cannot be undone from the Documents group.** D46 undo is drawn
  in the "pending changes" list, which a `doc_attach` deliberately does not join
  (it is keyed on `record`, not `ticket`). The event is still undoable through
  the normal `DELETE /api/event/:id` path; there is just no button for it. Worth
  a decision if techs start asking.

---

# D52 — Map view on the Dispatch tab (2026-09-09, schema 7)

Built from the D52 work order. `docs/wi-map.svg` committed **as received** — not
regenerated, not hand-edited, not restyled (it paints from CSS variables). New
pure module `docs/map.js`; the Dispatch tab gains a List | Map control.

## What shipped

**`docs/map.js`** (pure) — the projection read off the SVG root, viewBox math
(project a lat/lng box, clamp, zoom-about-a-point), the §3.3 pin table,
stacking, the off-map split, and the two Google Maps URL builders.

**`docs/app.js`** — `#/dispatch/map`, the segmented control, the inlined SVG
with pins spliced in as real children, pointer-event pinch/pan, the ⌂/⤢
buttons, filter chips, the tap sheet, the route builder and the off-map list.

**Mock** — `meta.geo` plus `geo` on all four row types, from a fake geocode
cache **keyed on the address string**, exactly as the real one is.

## Decisions I made

- **Stacking keys on the exact coordinate, not a distance threshold.** The cache
  is keyed on the address, so two rows at one plant carry byte-identical `geo`.
  A radius would invent clusters the data never claimed and would make the
  "1 pin, 6 rows" case depend on a magic number.

- **`stackKind` is a priority order** (service → pickup → delivery → lead →
  rental), so a broken machine at a plant colours the pin rather than whichever
  row the loop happened to reach first. Work beats inventory.

- **Shapes carry the same signal as the colours** — circle / square / diamond /
  small dot, triangle for a demo lead. Five colours alone is a bad bet on a
  phone in sunlight, and worse for a red-green reader.

- **Pins counter-scale by the viewBox width**, so they stay the same size on
  screen at any zoom, and labels vanish entirely above a 300-unit span (the
  whole-state view), where they were an unreadable grey smear.

- **`touch-action` is driven from the zoom level.** At minimum zoom the map has
  nowhere to pan, so a one-finger drag belongs to the PAGE — the off-map list is
  underneath and has to be reachable. Once you zoom in it flips to `none` and
  the drag is the map's. Two fingers always zoom. That is the exit criterion
  about not hijacking page scroll, implemented rather than hoped for.

- **The gestures mutate the live `viewBox` attribute and re-scale the pins by
  hand, instead of re-rendering.** A re-render per `pointermove` would rebuild
  ~150 KB of innerHTML forty times a second. `render()` picks the parked
  viewport back up the next time something real changes.

- **A deep link to `#/dispatch/map` sets the tab for the session but does not
  write `localStorage`.** Following somebody's map link should not silently
  re-default a dispatcher who works off the list; tapping the control does
  persist.

- **Switching every filter chip off restores all five.** A blank map reads as a
  broken map, and there is no way back from one except a chip nobody can see.

## Tests

`npm test` — **30 map + 88 render checks** (257 across the suite).

The projection is asserted **against the shipped asset's own geometry**: the
test ray-casts the projected shop coordinate through the 72 county polygons in
`wi-map.svg` and requires Jefferson County, with Milwaukee, Madison and Green
Bay as controls. A made-up-constants unit test cannot catch a regenerated asset;
this one can.

Render checks drive the real view: the SVG is inlined (asserted *not* an
`<img>`) at the projected `default_view`; every pin matches `collect()` exactly
and every off-map row appears **only** in the list; hollow-vs-solid follows
precision; a stacked pin carries its count and its sheet lists every row with an
Open link that is then **followed** to prove it is not a dead route; three
tapped stops produce a directions URL with the shop as origin, the stops as
waypoints in tap order, and `pending.length === 0` — nothing written; the List
view still renders unchanged; a schema-6 snapshot says "No map in this snapshot"
instead of drawing a blank one.

I also parsed the spliced output as XML out-of-band: well-formed, 72 counties,
27 pin groups.

## Things worth flagging

- **`CLAUDE.md` has an uncommitted edit that reverts the schema-6 sections.** I
  left it exactly as I found it and staged nothing from it — see the session
  report. It adds the v2.6/v2.8/D52 header lines and the `wi-map.svg` layout row
  (all wanted), but also deletes the `doc:`/`docmeta:` KV rows, the five doc
  endpoints, the `doc_attach` event shape and the Documents block, and puts the
  write-model heading back to "nine actions". The header it adds says the five
  doc endpoints exist while the table below no longer lists them, which is what
  makes it look like a paste from an older base rather than a decision.

- **Pinch/drag could not be exercised in the harness.** There is no pointer-event
  DOM here. The arithmetic underneath (`clampViewBox`, `zoomAt`) is unit-tested,
  including that a pinch holds its centre still; the px→units conversion and the
  drag anchoring are reasoned about in comments and need a real phone.

- **I found and fixed a pan bug while reviewing that code**: the drag anchor was
  re-derived from the *live* viewBox each frame, so every move re-measured
  against the position the previous move had just set and the map crawled behind
  the finger. Both the anchor and the scale now come from the viewBox the
  gesture started in.

- **`Number(null)` is `0`** — the first version of `usableGeo` accepted a null
  longitude as the prime meridian and would have pinned a Wisconsin customer off
  the coast of Africa. Caught by the fixture test; the module now has one strict
  numeric guard used everywhere, including the URL builders.

- **The mock needed street-level job sites.** With town-level addresses every
  row in a town collapsed onto one pixel — 10 pins for 41 rows — which made the
  map a poor demo and meant stacking was only ever tested against an artefact.
  Sites are now `<street>, <town>` and the fake cache offsets street/rooftop
  hits deterministically from the whole string, so the same address is always
  the same point and different ones are not. City-precision hits keep the town
  centroid, which is exactly why they draw hollow.

---

# D53 — Map facelift (2026-09-09)

Amends D52. Schema stays 7; the one contract change is `meta.geo.default_view`,
read from the snapshot as before. `docs/wi-map.svg` committed **as received**
(`sha256 a49c17f0176e7d1406e3bd08aa574573b38a77b1a0096cf10de8d726d7fa50ff`) —
not regenerated, not hand-edited, not restyled.

## What shipped

**The overrides are gone.** `style.css` no longer declares a single `--map-*`
variable. The asset carries the intended values as fallbacks, so it now renders
as designed: light grey land, blue water, white roads on grey casing, tiered
city labels. A test fails if any override comes back.

**New pin palette, nothing red** — purple / orange / blue / green / teal, plus
the brand-red shop house. Filter chips wear their own kind's colour (filled on,
outlined off) and the legend swatches match.

**Teardrop markers with ID chips.** Tip on the coordinate, ~22 px tall,
counter-scaled. A white pill beside the head carries the ticket number, lead id
or serial in the kind's colour, visible at the default zoom and anything
tighter, hidden above 1.6× the opening view.

**Hollow markers retired.** `solid` is gone from `map.js`, `app.js` and the CSS.
Precision is now a sentence in the tap sheet: "**City center** — no street
address on file" / "**Approximate** — street, no number", and nothing at all for
a rooftop hit. A stack reports the *best* precision of its rows.

**Box sized to the opening view**, so the dead band under the state is gone.

## Decisions I made

- **The box is 1.20× wider than the view, not exactly its aspect.** §4's formula
  produces a frame that ends at `default_view`'s east edge — and I measured the
  asset's own label geometry against it: **"Milwaukee" runs 14.7 user units past
  that edge, "Kenosha" 3.3, "Sheboygan" 31.9.** Sized exactly to the view, the
  biggest label on the board loses its tail, which is the opposite of the
  §8 exit criterion. SVG's `meet` fit fills leftover room with adjacent map, so
  a slightly wider box buys the labels back horizontally and costs only height —
  and vertical dead space was the thing being removed, so the trade is the right
  way round. On a 375 px phone the box is 237 px tall and the frame runs
  374.7–817.4 user units, clearing all three labels. See the contract note below.

- **The lead-in words are the site's, not the snapshot's.** `precision_legend`
  supplies only the explanatory half ("no street address on file"); "City
  center" and "Approximate" are hardcoded. A thin or missing legend can then
  never collapse the two cases into one indistinguishable line.

- **A rooftop hit says nothing.** Printing "Exact address" on nine pins out of
  ten trains people to stop reading the line, and then the one that matters gets
  skipped too.

- **A stack takes the best precision of its rows**, not the first or the worst:
  if one row is known to the rooftop then the *place* is.

- **Chip width is estimated, not measured.** This markup is built as a string
  like every other view here, and measuring needs a laid-out DOM. 5.4 units per
  character at 9 px is slightly generous for a bold sans — the right way to be
  wrong, since a pill a shade too wide looks deliberate and one too narrow clips
  the text it exists to show.

- **"Not red" is a hue test.** The mandated pick-up orange `#F97316` is 98% red
  channel; a naive channel test rejects it. The check computes hue, requires
  every kind outside 345°–15°, and additionally requires the five to sit >25°
  apart from each other — so a future palette tweak cannot quietly make two
  kinds look the same.

## Tests

`npm test` — **268 checks** (was 257), 36 map + 93 render.

New coverage: the hollow marker is gone from code *and* markup; a stack reports
the best precision; the precision line appears for city/street and not for
rooftop; every marker is the same teardrop; no pin colour is in the red band and
no two are within 25°; `style.css` declares no `--map-*` override and the asset
still carries its fallbacks; every pin has an ID chip at the default view, the
whole state switches them off and coming home switches them back; the box
aspect is wider than the view and narrower than a letterbox.

The frame check is the one worth keeping: it parses the **asset's own** city
labels, estimates their widths from bold-grotesque advance tables, computes the
visible extent from the box aspect, and fails if any label overlapping the frame
is drawn half off it. That is the D53 exit criterion as arithmetic rather than
as an eyeball, and it survives a regenerated asset. Monroe and Beloit are
asserted to clear the bottom edge, descenders included.

I also re-parsed the rendered map as XML out-of-band: well-formed, 72 counties,
48 lakes, 28 teardrops, 28 ID chips, 11 count badges, zero "hollow".

## Things worth flagging

- **`default_view` is ~0.09° short of clearing "Milwaukee" on its own.** The
  allowance handles it today, but the clean fix is in the contract: **`lng_max`
  −87.22** (instead of −87.45) puts the east edge past "Sheboygan", the widest
  overhang, with no allowance at all. Ship that and
  `EDGE_LABEL_ALLOWANCE` in `docs/map.js` goes to 1 — one constant, and the test
  that measures the labels tells you immediately whether it worked.

- **The bleed reveals a sliver of the west.** At the opening frame the left edge
  sits at lng −90.31 rather than the contract's −90.05. Nothing is clipped
  there (La Crosse is well outside), and it costs nothing; it is simply what
  centring the extra width does.

- **`CLAUDE.md` still has the uncommitted edit that reverts the schema-6
  sections** — unchanged from the D52 report, still staged out of my commits,
  still worth resolving before another session reads it as the brief.

- **Pinch/drag remains unverified on hardware.** Unchanged by D53; the clamp and
  zoom arithmetic are unit-tested, the gesture feel still needs a phone.

---

# D62 — Completed-ticket history (2026-09-24, schema 7, additive)

Built from `Completed-History-Site-Spec.md` against `CLAUDE.md` v3.4. BUILD
`2026-09-24-d62`, SW `wss-fleet-shell-v32`. **Pages only — no Worker change,
no Worker deploy, no role gate** (tickets were never gated; D12).

## What shipped

- **`docs/service.js`** — `closedAge(t)` (the engine's `closed_age_days`; a
  missing key reads as 0 = this week), `closedThisWeek(t)`, `onBoard(t)`,
  `closedWindowDays(summary)` (missing → 7) and `completedTickets(queue,
  {filter, query})`. `columnize()` drops CLOSED tickets older than 7 days from
  **every** column, not just COMPLETE. `pipeline().closedThisWeek` counts ≤ 7
  only. No date arithmetic anywhere — the age is the engine's.
- **Service tab** — `▸ Completed` strip between the kanban and the swipe note,
  same anatomy as the Leads Closed strip. Collapsed by default; open state and
  query live in `ui` (per session, not persisted). Pill = `closed_in_window`
  under **All** (like the column counts use the summary), else the drawn
  count — so under Fleet/Customer the pill matches the filtered list. Rows:
  customer · S-number chip / equipment (or `#serial model` for ours) · Closed
  date · assignee initial · 📎N. Newest closed first, ticket id descending on a
  tie. Chip filter applies.
- **Search** — the `input` handler redraws `#completed-list` only; the box is
  never rebuilt, so the phone keyboard stays up (verified in the browser pane:
  focus held through typing). Case-insensitive substring over customer /
  equipment / serial / ticket / issue. The box is omitted when there is nothing
  to search.
- **Mock** — nine CLOSED tickets (ages 2, 5, 12, 19, 23, 34, 47, 61, 80): two
  inside the week, one WSS-owned (19d), two with docs. `service_summary` gains
  `closed_window_days: 90` + `closed_in_window`; `open_by_stage.COMPLETE` is
  now computed as CLOSED ∧ age ≤ 7. The ticket helper takes `closedDays` and
  derives `status` / `stage` / `closed` / `closed_age_days` from it.

## Tests

`npm test` — **service 37** (+5: COMPLETE ≤ 7 and the 8-day ticket in no
column; strip order; search on every field + chip filter; `closedThisWeek`;
the pre-D62 legacy path), **render 114** (+2: the strip against the real
`app.js` — collapsed, pill, order, search redraws the list only and not the
view, Fleet chip; and a legacy snapshot with the keys stripped: every CLOSED row
in COMPLETE, pill = drawn count, empty copy says 7 days). The existing
pipeline-pill render check now asserts the week count, not the 90-day total.

`npm run money-gate -- ~/.wss-runs/real-snapshot-schema5.json` — **16 passed,
0 failed** (nothing here touches leads; run for the record).

## Things worth flagging

- **The engine publish must wait for Pages.** A phone still on v31 would stack
  all ~18 closed rows in the COMPLETE column and read "18 closed this week".
  The SW bump to v32 is what moves installed phones onto the new shell.
- A CLOSED ticket whose `stage` is not COMPLETE (shouldn't happen) now also
  leaves the board after 7 days — it still appears in the strip.

---

# D62b — Completed search moves into the Service Pipeline widget (2026-09-24)

Spec: `Completed-History-Site-Spec.md` §"v1.1 — Placement" (Matt, after seeing
v1.0 live: the strip below everything was in a weird place). BUILD
`2026-09-24-d62b`, SW `wss-fleet-shell-v33`. Pages only; no engine, no Worker.

## What changed

- **The strip under the kanban is gone.** The swipe note stays where it was.
- **The pipeline widget has a tenth row**, directly under *Ready to invoice*:
  a filled maroon pill **button** `Completed ▸` (soft maroon with border once
  open, `▾`) and a count pill. No bar, no percent, no `data-pipe` — it never
  scrolls the kanban. The row is a `<div>`, not a `<button>` like the nine
  stage rows, because the label itself is the button (no nested buttons).
- **The panel opens inside the widget card** under that row: the same search
  box, same fields, same list-only redraw (`#completed-list`), same rows, same
  empty/miss copy. Open state + query still live in `ui`, per session.
- **Chips:** the widget renders under All and Customer only, so under **Fleet**
  there is no Completed row — accepted by the spec; All lists our own closed
  tickets too. The pill rule from v1.0 stands: `closed_in_window` under All,
  the drawn count under a chip.
- Unchanged from v1.0: COMPLETE column = this week, `closedThisWeek` ≤ 7,
  the pre-D62 fallback, `service.js` helpers untouched.

## Tests

`npm test` green — render 114: the D62 render checks now target the widget
(row inside the pipeline card, last, after READY-TO-INVOICE; button not a
plain label; no bar/percent/`data-pipe`; no strip left under the kanban; panel
opens inside the card; search redraws only the list; Customer chip filters and
the pill is the drawn count; no row under Fleet; All lists WSS tickets). The
legacy-snapshot check reads the new pill. Service 37 unchanged.
`npm run money-gate -- ~/.wss-runs/real-snapshot-schema5.json` — 16 passed, 0 failed.

---

# D63 — in-place re-renders keep the scroll position (2026-09-24)

BUILD `2026-09-24-d63`, SW `wss-fleet-shell-v34`. Pages only.

## The bug

`render()` ended with `view.scrollTop = 0; window.scrollTo(0, 0)` every time.
Every write goes through `render()` without changing the hash (stage change,
claim, done, readiness, note, assign, opening a sheet, a chip), so each one
threw the reader to the top of a long ticket or Dispatch board.

## The fix

A module-level `lastRenderedHash` (null until the first full render, so boot
always starts at the top). `render()` captures `window.scrollY` and
`#view.scrollTop` before the `innerHTML` swap when the hash matches, and after
the swap restores only what drifted (a closing sheet can make the view
shorter, and the browser clamps). A new hash is a navigation and still
scrolls to the top. The Dispatch deep-link `scrollIntoView` keeps priority.
No new scrolling was added anywhere. The confirmation line is not chased, so
it can push content down by one line (~50px), and that's fine.
Loading and error renders don't touch `lastRenderedHash`.

## Verified at 375×812 against a local Worker (real writes, not mock mode)

- Ticket S1004: opened the stage sheet, then submitted "Move to Ready to
  schedule". `scrollY` stayed at 1151.5 through both renders, and the picker
  stayed on screen (top 645px of 812). The page showed "Submitted".
- Dispatch, lowest Claim (m-pu-900240): scrolled to the sheet's submit and
  submitted. `scrollY` stayed at 968.5, and the row stayed on screen with its
  "⏳ 1 pending" line and Undo button. Once the sheet closes, the top of the row
  sits under the sticky header. That's expected: nothing re-scrolls.
- Test events acked afterwards, and the local KV was restored to the mock by
  money-gate.

## Tests

Render 116 (+2): two `render()` calls at the same hash never call
`scrollTo` and leave `#view.scrollTop` alone. A hash change calls
`scrollTo(0, 0)` exactly once and zeroes `#view.scrollTop`. `npm test` green.
Money-gate 16 passed, 0 failed.

---

# D64 — rental lifecycle (2026-09-24)

BUILD `2026-09-25-d64`, SW `wss-fleet-shell-v35`. **Worker first, then Pages.**
Spec: Rental-Lifecycle-Site-Spec (vault). CLAUDE.md v3.4 → v3.5, copied verbatim
from the vault's `Site-Repo-CLAUDE.md` (the diff was D64 hunks only).

## Legacy tolerance, checked first

Before any view changed, the mock gained every D64 key (PENDING / OFF-RENT
rows, `next_due: null`, a `RENTAL-DELIVER` row, `agreement` on every dispatch
row, `pending_agreement`, `agmt:` holds) and the **pre-D64 app** rendered it:
all 116 render checks green, every route in all three variants and roles.
Unknown sources get no glyph, a null `next_due` draws "—", and `canCancel` was
already MANUAL-only. The one wart: an `agmt:` hold showed a Release button the
engine would refuse. No crash anywhere.
**Not checked against the live `/api/data`**: no crew token on this machine.
`node tools/smoke-real.mjs <live snapshot>` does it (it now walks every
`#/agreement/<id>` too).

## Worker

`rental_update` (the fourteenth action) for `sales` + `owner`. Payload:
`agreement` (int → positive safe integer, string → the ref-id shape; kept in the
type it arrived in), `action` ∈ OUT·OFF-RENT·IN, optional `date` (YYYY-MM-DD),
optional `note` (≤ 200). Shape only — "not in the future" is the engine's and
the picker's. m1-loop +15 checks (403 for service; 400 for bad or lower-case
verb, a missing, traversal-shaped or fractional agreement, a malformed date, a
201-char note; 201 for a string id and an int id; D46 undo). 187 passed.

## Site

- **`docs/rentals.js`** (new, pure): `statusOf` (legacy → ACTIVE), the three
  groups and their orders, the role × status × move button matrix,
  `dueBackTone` (red < today, amber ≤ tomorrow), `outDatePassed`,
  `clampToToday`, the delivery and return row lookups, and `pendingForAgreement`,
  which matches the id strictly (`4211` is not `"4211"`). `billsNow` gates D21
  (`metrics.recurringRevenue`): ACTIVE + OFF-RENT + legacy, never PENDING.
- **Rentals**: revenue, then **Pending** (soonest out first), **On rent**
  (longest `days_on_rent` first; a legacy file keeps the old severity order),
  **Off-rent** (oldest `off_rent` first). Empty Pending and Off-rent groups are
  omitted, so a legacy file looks like it did before. Buttons: Went out,
  Off-rent (filled maroon, with the in_move caption) and Back in shop (owner
  override on PICKUP tiles, drawn as a ghost button with a caption). Each opens a
  sheet with date (default = max = today) and note. A future date is refused
  before the POST. Pending state is keyed on `payload.agreement`: the tile shows
  ⏳ pending, the button is disabled, and Undo is offered.
- **`#/agreement/<id>`**: full fields, the actions, the Moves (delivery and
  return rows), and Documents (no add buttons: an R-number is not a record a
  phone can attach to). There is **no Notes timeline**, because agreements
  carry no `log[]` in schema 7.
- **Dispatch**: RENTAL-DELIVER rows get a **Rental delivery** chip and an
  R-number chip linking the agreement. Every row carrying `agreement` gets the
  chip, RENTAL-RETURN included. No Cancel (unchanged: MANUAL only). The Done
  copy reads "Marks R… on rent from today and closes lead L… as won." and drops
  the clause when there is no lead. Map: same blue DELIVER pin.
- **Unit page**: a "Reserved for rental R…" chip next to the state chip.
  Schedule delivery is hidden and replaced by a link to the `m-dl-*` row (or to
  the agreement for a customer pick-up). An `agmt:` hold renders as RENTAL with
  no Release and "clears itself on delivery". The Holds view books no truck
  for it either.

Contract note honoured: `rental_update` goes with **no top-level serial** (the
vault's v3.5 line: "absent on `rental_update` — it carries
`payload.agreement`").

## Verified

`npm test` green (rentals 12 new, dates +2, render 127 = +11). The browser at
375×812 on mock showed tiles, due-back tones, the sheet (today/max today), the
RENTAL-DELIVER row with its Done copy, the unit chip and link, and agreement
detail. A **real write through a local Worker as Kevin** stored
`{agreement:"R092526A", action:"OFF-RENT", date, note}` with `serial: null`.
The tile went ⏳ pending and disabled, and Undo removed the event (inbox back to
0). Money-gate 16 passed, 0 failed. smoke-real on the Sep-4 real file: 19 passed.

---

# D65 — internal work orders: parts + labor on fleet units (2026-09-24)

BUILD `2026-09-25-d65`, SW `wss-fleet-shell-v36`. **Worker first, then Pages.**
Spec: Parts-Request-Site-Spec (vault). CLAUDE.md v3.5 → v3.6, committed as
handed over (Matt's uncommitted copy — the D65 paragraph, the fifteen-action
write model, the Parts strip under the utilization card).

## Legacy tolerance, checked first

**Not checked against the live `/api/data`** — still no crew token on this
machine, and the browser pane had none stored either. Instead, as at D64: the
mock gained every D65 key first (`work_orders[]`, `work_order_summary`,
`units[].work_order` / `wo_parts_open`, two pending `work_order` events) and the
**pre-D65 app** rendered it — every route × all three variants × all three
roles green. The only failure was the new fixture's LABOR tap expecting an Undo
the old app had nowhere to draw. No crash anywhere. `node tools/smoke-real.mjs
<live snapshot>` walks every `#/wo/<W>` now too once somebody runs it on a live
file.

## Worker

`work_order` (the fifteenth action), any role at the action level; narrowed by
verb inside `cleanPayload`: PART-STATE → ORDERED and CLOSE **owner**; IN-TRANSIT
/ DELIVERED / CANCELLED **service + owner**; CANCEL passes for anyone (owner, or
`opened_by` before anything is ordered — business state, the engine's). `serial`
required on OPEN and **refused** on the other five verbs. Every verb has an exact
key list; an unknown key is a 400 (it is a new shape — no old client to be
lenient with). REQUESTED is refused as a target state: it is the one backwards
move the Worker can see without knowing a line's current state.

**The money refusal** (`refuseMoneyKeys`) runs on **every** action's payload,
before `cleanPayload`, so the 400 always names the key: `cost`, `rate`, `price`,
any case, any depth. No existing client sends any of the three.

m1-loop **+33 checks → 220 passed, 0 failed**: all six verbs (OPEN with lines,
labor-only OPEN, ADD-PARTS, the three part states, LABOR for someone else,
CLOSE, CANCEL, D46 undo); 403 for service ORDERED / sales DELIVERED / service
CLOSE; 400 for a 7th verb, an 11-line OPEN, a bad manufacturer, `S1001`, hours
13 and 1.3, → REQUESTED, OPEN without serial, LABOR with one, qty 0, an unknown
part key, and **cost / rate / Price by name** (one on a `ticket_update`, to prove
it is not work-order-only); and per role, `work_orders` carries no money key and
no `/\$\s?\d/`. `npm run money-gate` **22 passed** (the original 16 + 6: key and
text, per role) on the Sep-4 real file (no `work_orders` — passes vacuously and
says "no key") and on the mock.

## Site

- **`docs/workorders.js`** (new, pure): strip groups and their orders, the pill
  (the engine's summary; counted from rows only without one), `requestedTone`,
  the §5 line-button matrix, close/cancel gates, carrier links (UPS/FedEx/USPS
  only; a leading carrier word is dropped from the number), hours validation,
  OPEN defaults, pending keys. `tools/selftest-workorders.mjs`, 12 checks.
- **Landing**: `🔩 Parts ▸ N open` between the utilization card and the category
  cards, folded by default, open/closed kept in **sessionStorage** (per session,
  per the spec). Amber/red from `PARTS_AMBER = 3` / `PARTS_RED = 7`, beside
  `AGE_AMBER`. Expanded: part lines grouped Ordered · In transit · Requested,
  Delivered folded inside, pending OPENs as `⏳ NEW — <asset> — N parts` cards
  on top with Undo. Row = **PO W1001** · part # × qty · description · asset chip ·
  ordered · vendor · tracking · age · 🔧 ticket. A legacy / quiet snapshot draws
  the strip with `0 open` and "Nothing on order."
- **Unit page**: beside Set readiness — `Open work order` (any role), or the
  `🔩 W1001 · 3 parts open · 2.5 h` chip → `#/wo/W1001`, or a disabled `⏳ New
  work order` while an OPEN is pending. The OPEN sheet: purpose toggle (default
  RENT-READY on NEEDS-PREP, else REPAIR), line rows (make defaulted from `brand`,
  part #, description, qty) with `+ line` appended in place (no re-render, so
  typing survives), up to 10, note, `Links to S…` when the unit has a ticket.
- **`#/wo/<W>`**: `PO W1001` big; `W1001 · A-1019 · OPEN 1d · Rent-ready`; parts
  with per-line buttons by role × state, each opening a sheet asking only for
  what that state stamps (ORDERED: date, vendor defaulted from the make —
  Factory Cat/Kodiak → RPS — vendor #, and the reminder to give them the PO;
  IN-TRANSIT: tracking; DELIVERED: date). `+ Add parts`, labor rows with
  `+ Log hours` (date, who defaulting to you, a ±¼ h stepper, 0.25–12), Close
  (owner, disabled with the reason while a line is open), Cancel (owner, or the
  opener before anything is ordered), and the log newest first. No rate, no
  dollars, no cost column.
- **Ticket detail**: read-only `🔩 W1003` chip when the ticket's unit has one.
- **Pending**: OPEN keyed on the top-level serial (never an invented id); the
  other verbs on `payload.work_order` — the WO page lists them with Undo, and a
  line with a pending state change shows `⏳ → Ordered` and loses its buttons.

## Decisions I made

1. **The strip always draws**, even on a legacy snapshot (`0 open`, "Nothing on
   order.") — read "empty strip on a legacy snapshot" literally, and it gives a
   pending OPEN somewhere to show on a quiet day.
2. **Delivered (30d)** shows every DELIVERED line the snapshot carries; the
   30-day window is the engine's and I don't re-filter dates client-side.
3. **Part description is optional** at the Worker (part # and qty are what a
   vendor needs); the site asks for it but only a part # is required.
4. **Cancel line for service** only on work orders they opened (the spec's
   "own WO only"), matched on `opened_by` vs the token name — the engine
   enforces it anyway.
5. **No publish-side refusal** of a snapshot carrying a money key on a work
   order. The spec puts that guarantee in the builder; a Worker refusal would
   stop the hourly publish outright. The tests hold the builder to it instead.

## Ride-along fix

`tools/make-mock-data.js` anchored its `TODAY` on the **UTC** date, so after
7 pm CT every mock "yesterday" was today on the page and the D64 check
"yesterday and still PENDING: red" failed — reproduced on a clean HEAD
checkout. `TODAY` is now Central (`Intl.DateTimeFormat` with
`America/Chicago`), matching `todayCentral()`.

## Verified

`npm test` green (workorders 12 new, render 127 → 137), also under
`TZ=Pacific/Pago_Pago` and `TZ=Pacific/Kiritimati`. Browser at 375×812 on the
mock: folded and open strip, the WO page, the OPEN sheet with a second line; no
console errors. A **real write through the local Worker as Josh**: the OPEN
stored `{serial:"900198", payload:{action:"OPEN", purpose:"RENT-READY", note,
parts:[2 lines]}}`, the unit page flipped to `⏳ New work order`, the strip drew
`⏳ NEW — A-1014 — 2 parts`, and Undo from the card took the inbox back to 0.
smoke-real on the Sep-4 file: 19 passed.

---

# D67 — the fleet inspection sheet: check-out / return / PM (2026-09-25)

Built from `Inspection-Site-Spec.md` v1.0 against `CLAUDE.md` v3.7. Schema
stays 7; one new action (sixteen). The engine was already publishing the keys —
the pre-D67 build was verified first to tolerate them (213 renders, three roles,
zero throws or leaks; `#/inspection/…` fell back to the landing page).

## What shipped

- **Worker**: `inspection`, five verbs, shape + enums + lengths only (see the
  README action table). `work_order` OPEN takes an optional `inspection`
  back-link. The row library is **not** on the Worker. `MAX_EVENT_BYTES`
  8 KB → 32 KB so a whole sheet fits one event.
- **Landing**: `📋 Inspections ▸ N drafts · M done this week` under the Parts
  strip, folded, remembered per session, amber at `INSPECT_AMBER = 2` days
  (engine `age_days`). Drafts oldest first with Resume, then Done (7d) with
  tech · hours · ⚑ · WO chip; a pending OPEN is a `⏳ NEW` card keyed on its
  serial. "No inspections yet" when there are none (legacy, or empty).
- **Unit page**: `412.5 h · as of 9/24` in the header; beside Work order,
  `📋 Resume I1005 · CHECKOUT · 3 ⚑`, `⏳ Resume new sheet`, or `📋 Inspect` →
  Check-out · Return · PM with the §2 default lit; Inspections list (last 5).
- **`#/inspection/<I>`** (and `#/inspection/new/<serial>`): rendered from
  `inspection_checklist` — no row is named in the site. Machine dropdowns
  re-filter and keep every answer; readings follow the class, hours first and
  big; battery type → voltage → pack with the WET grid grouped per pack; one
  segmented control per row in the row's own scale + N/A (tap the lit answer to
  clear it); a flag tints the row and opens its note; `n/m answered` per
  section; comments; Done (disabled until an hours reading) · Void. DONE:
  read-only, Reopen, and "Open work order from this inspection" → the D65 OPEN
  sheet pre-filled (purpose, `from I1003: <flagged labels>`, the back-link).
- **Chips**: `📋 I1005` on the ticket the engine linked; `📋 I1002` on the work
  order opened from a sheet.
- **Saving**: every change marks its section dirty; a save follows 2.5 s later,
  or at once on blur / a dropdown pick / leaving the route / the app going to
  the background. One SAVE per section; a newer save of a section takes back
  my older unapplied save of that same section (D46), so the inbox holds one
  per section. A failure pins "Didn't save — tap to retry" above the tab bar.

## Decisions I made on the floor (the spec didn't settle these)

1. **A sheet typed before its I-number is folded into the pending OPEN, not
   queued as serial-keyed SAVEs.** The spec says SAVEs "queue against serial",
   but the live engine's SAVE and DONE are keyed only on `payload.inspection`
   (`wss_inspections.h_inspection` → `find(payload.get("inspection"))`) — a
   serial-keyed SAVE would be refused and the tech's typing lost. What the
   engine *does* accept is an OPEN carrying the first sections ("OPEN may carry
   a first SAVE"). So each save on a NEW sheet re-POSTs the OPEN with every
   section typed so far, then DELETEs the previous one: one OPEN in the inbox,
   always the latest. If the take-back 404s (the engine drained it mid-save) the
   fresh OPEN is withdrawn too and the tech is told to finish on the numbered
   sheet. The Worker still **accepts** a serial-keyed SAVE per the spec, so the
   engine can add the serial fallback later without a Worker deploy.
2. **Done waits for the I-number** on a NEW sheet — same root cause: a DONE
   with no id is refused by the engine. The footer says so ("Done unlocks once
   the engine numbers this sheet"). The spec's exit story (open → fill → Done in
   one sitting) needs the engine to resolve `serial → its DRAFT` for SAVE and
   DONE. **Flagged to the Architect.**
3. **Kind is editable only on a NEW sheet.** The engine's SAVE merge has no
   `kind` section, so on a numbered sheet the kind is text, not a dropdown.
4. **Answers on rows the machine no longer shows stay on the phone, not in the
   vault.** A SAVE sends only the answered rows the current class / controls /
   battery sees (plus a retired row the sheet already carries). Flipping back
   restores them within the session. Otherwise a horn flag on a walk-behind
   would count toward `flags` and land on the work order.
5. **Battery**: no pack is guessed when the voltage is picked — the grid waits
   for the pack. Changing voltage clears a pack that no longer fits. Cells
   typed under one pack stay on the phone if the pack/type changes.
6. **Hydrometer**: `1265` reads as `1.265` (gloves); anything outside
   1.000–1.400 turns the field red and is not saved.
7. **Work order from a RETURN** gets purpose REPAIR (the spec names PM → REPAIR
   and CHECKOUT → RENT-READY only). The note is cut to 200 with `…`. If the unit
   already has an OPEN work order, the button is replaced by a link to add the
   parts there (the engine allows one OPEN per serial).
8. **Reopen for the tech** is drawn only when the DONE row in the sheet's
   `log[]` is ≤ 24 h old by Central wall clock (the same stamp the engine
   reads); no stamp → owner only. **Void** on a DONE sheet is owner-only.
9. **Done asks for the tech** (defaults to you) and saves anything unsaved
   first; if that save fails, Done refuses rather than lock a sheet missing its
   last section.
10. **"No inspections yet"** also shows on a snapshot that ships the keys but
    no sheets (the empty mock), not only the legacy one.
11. **Money gate**: `tools/money-gate.mjs` applies the D65 check (no money key,
    no `/\$\s?\d/`) to `inspections[]` and the shipped library, every role. Note
    comments and item notes are typed text — if a tech ever writes a dollar
    figure in one, this fails on honest data; the contract says nothing on the
    sheet is money-shaped, so I held it to that.

## Tests

- `tools/selftest-worker.mjs` (new, 8) — drives the real `worker.js` against an
  in-memory KV, so the Worker's rules now run under `npm test`: five verbs
  accepted; a 6th verb, `inspection: "W1001"`, 19 cells, sg 2.0, an unknown
  top-level key and a result outside both scales refused; lengths / enums /
  shapes; the money refusal; the `work_order` back-link; undo.
- `tools/selftest-inspections.mjs` (new, 18) — the pure module.
- `tools/selftest-render.mjs` 137 → 157 — spec §8's sheet / unit / strip cases,
  the save pipeline against a fake Worker (per-section SAVE + take-back, the
  NEW-sheet fold, the 404 race, Done-saves-first, WO back-link, undo), the
  redirect when the I-number lands, no money on any sheet, and a new guard that
  every module `app.js` imports is precached by `sw.js`.
- `npm test`: **424 checks** (378 before). `npm run m1` against `wrangler dev`:
  **234 / 0** (14 new inspection cases). `npm run money-gate` on the mock:
  **28 / 0**.
- The engine's own `_merge` (run read-only from the vault's `_templates/` with
  bytecode off; nothing written) accepted every payload shape the site builds,
  including the browser's folded OPEN — and refused a retired row on a sheet
  that never carried it, as the site assumes.

## Ride-along

- The mocks were regenerated: they are anchored on the day they're built, and
  the D64 "due yesterday / tomorrow" check had drifted overnight — **`npm test`
  was red on a clean HEAD this morning** until `npm run mock`. Worth knowing:
  any day-old mock will do this.
- Mock units' `hours` are now `null` except where a DONE sheet wrote them back,
  which is what the real fleet looked like before D67.
